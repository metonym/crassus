// Confirms rung-1 cascade flips in a real engine. A flip says the winner
// between two rules that may match one element changed; most pair rules no
// element carries together. So: drop a flip whose combination no fixture
// renders when the fixtures know all its classes (the co-occurrence model:
// the page index), and render the rest, on the fixture page that has the
// element or on a synthesized one, with base and head: only a flip whose
// property's value changes there is confirmed.
import { relaxSelector, stateTriggers } from "../core/impact";
import { synthesize, type Tree, vocabularyOf } from "../core/synth";
import { STATE_RE, STATE_SETS } from "../page/states";
import type { PageIndex } from "./page-index";
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
const PREFIX_RE = /^[a-z]+--/;
const ROOT_SPLIT_RE = /__|--/;

// Builds a tree into a document; `live` replaces the page's own.
const BUILD = `(tree, doc) => {
  const make = ([name, attrs, children, ns]) => {
    const el = ns ? doc.createElementNS(ns, name) : doc.createElement(name);
    for (const [k, v] of Object.entries(attrs)) { try { el.setAttribute(k, v); } catch {} }
    for (const c of children) el.append(make(c));
    return el;
  };
  const root = make(tree);
  doc.replaceChild(doc === document ? root : doc.adoptNode(root), doc.documentElement);
  return root;
}`;

const componentOf = (cls: string) =>
  cls.replace(PREFIX_RE, "").split(ROOT_SPLIT_RE)[0];

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
        const of = (el) => new Set(Array.from(el.classList, (c) => c.replace(/^[a-z]+--/, "").split(/__|--/)[0]));
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
    const rewrite = (css: string) => css.replace(STATE_RE, "[data-cr-$1]");
    await view.evaluate(
      `window.__crSheets = ${JSON.stringify({ base: rewrite(opts.base), head: rewrite(opts.head) })}`,
    );
    const render = (
      tree: Tree,
      at: number | null,
      f: FlipCheck,
    ): Promise<{ matched: boolean; before: string; after: string } | null> => {
      // The states each selector needs, on the elements it needs them on.
      const states = f.selectors.flatMap((s) =>
        stateTriggers(s).flatMap((t) =>
          t.prefix
            ? [
                {
                  prefix: t.prefix,
                  names: t.within ? ["focus-within"] : STATE_SETS[t.state],
                },
              ]
            : [],
        ),
      );
      const pseudo = PSEUDO_RE.exec(f.selectors.join(" "))?.[0] ?? null;
      return view.evaluate(`((tree, at, relaxed, states, property, pseudo) => {
        const root = (${BUILD})(tree, document);
        // By its place in the tree as built: before the style goes in.
        const el = at === null ? document.querySelector("[data-cr-target]") : document.querySelectorAll("*")[at];
        if (!el) return null;
        const head = document.head || root.appendChild(document.createElement("head"));
        const style = document.createElement("style");
        head.append(style);
        let matched = false;
        try { matched = el.matches(relaxed[0]) && el.matches(relaxed[1]); } catch {}
        for (const { prefix, names } of states) {
          let hits = [];
          try { hits = document.querySelectorAll(prefix); } catch {}
          for (const h of hits) for (const n of names) h.setAttribute("data-cr-" + n, "");
        }
        const read = (css) => {
          style.textContent = css;
          return getComputedStyle(el, pseudo).getPropertyValue(property);
        };
        return { matched, before: read(window.__crSheets.base), after: read(window.__crSheets.head) };
      })(${JSON.stringify(tree)}, ${at}, ${JSON.stringify(relaxed[opts.flips.indexOf(f)])}, ${JSON.stringify(states)}, ${JSON.stringify(f.property)}, ${JSON.stringify(pseudo)})`);
    };

    const out: FlipVerdict[] = [];
    for (const [i, f] of opts.flips.entries()) {
      const hit = found[i];
      if (hit) {
        // biome-ignore lint/performance/noAwaitInLoops: one page at a time
        const r = await render(opts.index.pages[hit.page].skeleton, hit.at, f);
        if (r?.matched) {
          out.push({
            verdict: r.before === r.after ? "no change" : "confirmed",
            on: hit.page,
            before: r.before,
            after: r.after,
          });
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
      let done = false;
      for (const tree of plausible) {
        // biome-ignore lint/performance/noAwaitInLoops: the first candidate that matches
        const r = await render(tree, null, f);
        if (!r?.matched) continue;
        out.push({
          verdict: r.before === r.after ? "no change" : "confirmed",
          on: "synthesized",
          before: r.before,
          after: r.after,
        });
        done = true;
        break;
      }
      if (!done) out.push({ verdict: "unsynthesized" });
    }
    return out;
  } finally {
    view.close();
  }
}
