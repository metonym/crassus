// Confirms rung-1 cascade flips in a real engine. A flip says the winner
// between two rules that may match one element changed; most pair rules no
// element carries together. So: drop a flip whose combination no fixture
// renders when the fixtures know all its classes (the co-occurrence model:
// the page index), and render the rest, on the fixture page that has the
// element or on a synthesized one, with base and head: only a flip whose
// property's value changes there is confirmed.
import {
  defaultComponentOf as componentOf,
  PREFIX_RE,
  ROOT_SPLIT_RE,
} from "../core/diff";
import { relaxSelector } from "../core/impact";
import { synthesize, type Tree, vocabularyOf } from "../core/synth";
import { asAttrs, matchable, stateSets } from "./coverage";
import { BUILD, type PageIndex } from "./page-index";
import { type EngineName, View } from "./view";

export interface FlipCheck {
  /** The two rules' selectors on head. */
  selectors: [string, string];
  property: string;
}

export interface FlipVerdict {
  /**
   * `confirmed`: the value changes on an element both match. `no change`:
   * it doesn't. `never seen`: no fixture has an element both match, and
   * the fixtures use every class and attribute they need. `unsynthesized`:
   * no candidate DOM matched both (unconfirmed, kept).
   */
  verdict: "confirmed" | "no change" | "never seen" | "unsynthesized";
  /** Where it was rendered: a fixture page (by label), or `synthesized`. */
  on?: string;
  before?: string;
  after?: string;
}

const PSEUDO_RE = /::?(before|after)\b/;

/** A tree's component pairs: on one element (`+`) and nested (`>`). */
function componentPairs(tree: Tree): [string, string, "+" | ">"][] {
  const out: [string, string, "+" | ">"][] = [];
  const walk = ([, attrs, children]: Tree, above: string[]) => {
    const mine = [
      ...new Set(
        (attrs.class ?? "").split(" ").filter(Boolean).map(componentOf),
      ),
    ];
    for (const x of mine) {
      for (const y of mine) if (x !== y) out.push([x, y, "+"]);
      for (const a of above) if (a !== x) out.push([a, x, ">"]);
    }
    for (const c of children) walk(c, [...above, ...mine]);
  };
  walk(tree, []);
  return out;
}

export async function confirmFlips(opts: {
  flips: FlipCheck[];
  base: string;
  head: string;
  index: PageIndex;
  engine: EngineName;
  chromePath?: string;
}): Promise<FlipVerdict[]> {
  const relaxed = opts.flips.map(
    (f) => f.selectors.map(relaxSelector) as [string, string],
  );
  const labels = Object.keys(opts.index.pages);
  const view = new View({ engine: opts.engine, chromePath: opts.chromePath });
  try {
    await view.navigate("about:blank");
    // Co-occurrence: the first indexed element each pair matches, and the
    // classes and attributes the fixtures use at all.
    const vocab = new Set<string>();
    const nested = new Set<string>();
    const components = new Set<string>();
    const found: ({ page: string; at: number } | null)[] = relaxed.map(
      () => null,
    );
    for (const label of labels) {
      const open = relaxed
        .map((pair, i) => (found[i] ? null : [i, pair]))
        .filter(Boolean) as [number, [string, string]][];
      // biome-ignore lint/performance/noAwaitInLoops: one page at a time
      const r = await view.evaluate<{
        vocab: string[];
        hits: [number, number][];
        nest: string[];
        comps: string[];
      }>(`((tree, pairs) => {
        const doc = document.implementation.createHTMLDocument("");
        (${BUILD})(tree, doc);
        const all = Array.from(doc.querySelectorAll("*"));
        const vocab = new Set();
        // Components (bx--slider__thumb: slider) nested in one another, and
        // sharing an element.
        const nest = new Set();
        const comps = new Set();
        const of = (el) => new Set(Array.from(el.classList, (c) => c.replace(/${PREFIX_RE.source}/, "").split(/${ROOT_SPLIT_RE.source}/)[0]));
        for (const el of all) {
          for (const c of el.classList) vocab.add("." + c);
          for (const a of el.attributes) if (a.name !== "class") vocab.add("[" + a.name + "]");
          const mine = of(el);
          for (const x of mine) {
            comps.add(x);
            for (const y of mine) if (x !== y) nest.add(x + "+" + y);
          }
          for (let a = el.parentElement; a; a = a.parentElement)
            for (const x of of(a)) for (const y of mine) if (x !== y) nest.add(x + ">" + y);
        }
        const hits = [];
        for (const [i, [a, b]] of pairs) {
          let els = [];
          try { els = Array.from(doc.querySelectorAll(a)); } catch { continue; }
          const el = els.find((e) => { try { return e.matches(b); } catch { return false; } });
          if (el) hits.push([i, all.indexOf(el)]);
        }
        return { vocab: [...vocab], hits, nest: [...nest], comps: [...comps] };
      })(${JSON.stringify(opts.index.pages[label].skeleton)}, ${JSON.stringify(open)})`);
      for (const v of r.vocab) vocab.add(v);
      for (const v of r.nest) nested.add(v);
      for (const v of r.comps) components.add(v);
      for (const [i, at] of r.hits) found[i] = { page: label, at };
    }

    // Both sheets, states rewritten to attributes, sent once.
    await view.evaluate(
      `window.__crSheets = ${JSON.stringify({ base: asAttrs(opts.base), head: asAttrs(opts.head) })}`,
    );
    const render = (
      tree: Tree,
      at: number | null,
      i: number,
    ): Promise<{ matched: boolean; before: string; after: string } | null> => {
      const f = opts.flips[i];
      const states = f.selectors.flatMap((s) => stateSets(s));
      const pseudo = PSEUDO_RE.exec(f.selectors.join(" "))?.[0] ?? null;
      const exact = f.selectors.map((s) => asAttrs(matchable(s)));
      return view.evaluate(`((tree, at, relaxed, exact, states, property, pseudo) => {
        const root = (${BUILD})(tree, document);
        // By its place in the tree as built: before the style goes in.
        const el = at === null ? document.querySelector("[data-cr-target]") : document.querySelectorAll("*")[at];
        if (!el) return null;
        const head = document.head || root.appendChild(document.createElement("head"));
        const style = document.createElement("style");
        head.append(style);
        let matched = false;
        try { matched = el.matches(relaxed[0]) && el.matches(relaxed[1]); } catch {}
        // States on, unless the rules apply without them (a state under :not()).
        const on = () => {
          for (const { prefix, names } of states) {
            let hits = [];
            try { hits = document.querySelectorAll(prefix); } catch {}
            for (const h of hits) for (const n of names) h.setAttribute("data-cr-" + n, "");
          }
        };
        const apply = (sel) => { try { return el.matches(sel); } catch { return false; } };
        if (!(apply(exact[0]) && apply(exact[1]))) on();
        const read = (css) => {
          style.textContent = css;
          return getComputedStyle(el, pseudo).getPropertyValue(property);
        };
        return { matched, before: read(window.__crSheets.base), after: read(window.__crSheets.head) };
      })(${JSON.stringify(tree)}, ${at}, ${JSON.stringify(relaxed[i])}, ${JSON.stringify(exact)}, ${JSON.stringify(states)}, ${JSON.stringify(f.property)}, ${JSON.stringify(pseudo)})`);
    };

    const judged = (
      r: { before: string; after: string },
      on: string,
    ): FlipVerdict => ({
      verdict: r.before === r.after ? "no change" : "confirmed",
      on,
      before: r.before,
      after: r.after,
    });
    const out: FlipVerdict[] = [];
    for (const [i, f] of opts.flips.entries()) {
      const hit = found[i];
      if (hit) {
        // biome-ignore lint/performance/noAwaitInLoops: one page at a time
        const r = await render(opts.index.pages[hit.page].skeleton, hit.at, i);
        if (r?.matched) {
          out.push(judged(r, hit.page));
          continue;
        }
      }
      const known = f.selectors
        .flatMap(vocabularyOf)
        .every((v) => vocab.has(v));
      if (known && !hit) {
        out.push({ verdict: "never seen" });
        continue;
      }
      // Only trees whose components nest and pair as some fixture's do;
      // components no fixture renders can't be judged.
      const trees = synthesize(f.selectors[0], f.selectors[1]);
      const plausible = trees.filter((tree) =>
        componentPairs(tree).every(
          ([x, y, how]) =>
            !components.has(x) ||
            !components.has(y) ||
            nested.has(`${x}${how}${y}`),
        ),
      );
      if (trees.length && !plausible.length) {
        out.push({ verdict: "never seen" });
        continue;
      }
      let verdict: FlipVerdict = { verdict: "unsynthesized" };
      for (const tree of plausible) {
        // biome-ignore lint/performance/noAwaitInLoops: the first candidate that matches
        const r = await render(tree, null, i);
        if (r?.matched) {
          verdict = judged(r, "synthesized");
          break;
        }
      }
      out.push(verdict);
    }
    return out;
  } finally {
    view.close();
  }
}
