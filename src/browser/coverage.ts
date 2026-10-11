// Mutation coverage: which declarations of the library stylesheet decide
// something on the fixtures. Each declaration is removed from its rule in
// the page (CSSOM), one at a time, and the elements the rule styles are read
// again: if no value changes, nothing the fixtures render depends on it.
import { relaxSelector, stateTriggers } from "../core/impact";
import { parseSelectorList, serializeList } from "../core/selector";
import { STATE_RE, STATE_SETS } from "../page/states";
import { serveFixtures, swappedSheet } from "./serve";
import { preparePage } from "./snapshot";
import { type VisitOptions, visitPages } from "./view";

export interface CoverageOptions extends Omit<VisitOptions, "baseUrl"> {
  /** The fixture directory, and the text only the library stylesheet contains. */
  dir: string;
  sheetMarker: string;
  /** The library stylesheet's CSS, swapped in for the fixtures' own. */
  css: string;
  settleMs?: number;
}

export interface RuleCoverage {
  /** The rule's selector text, as the engine has it. */
  selector: string;
  /** Pages it styles an element on (in a state it names, where it has one). */
  pages: string[];
  /** Whether its `@media` and `@supports` conditions held on some page. */
  held: boolean;
  /** Longhands whose removal changed a value it styles, somewhere. */
  covered: string[];
  /** Longhands it sets. */
  longhands: string[];
}

/** Pseudo-element names a computed style can be read for. */
const PSEUDO_RE =
  /::?(before|after|placeholder|marker|first-line|first-letter|selection|backdrop|file-selector-button)\b/;

/** State pseudo-classes rewritten to the `[data-cr-*]` attributes that stand in for them. */
export const asAttrs = (css: string) => css.replace(STATE_RE, "[data-cr-$1]");

/** The states `selector` needs, on the elements it needs them on (`prefix`). */
export const stateSets = (selector: string) =>
  stateTriggers(selector).flatMap((t) =>
    t.prefix
      ? [
          {
            prefix: t.prefix,
            names: t.within ? ["focus-within"] : STATE_SETS[t.state],
          },
        ]
      : [],
  );

/** `selector` without pseudo-elements: what `Element.matches()` takes. */
export function matchable(selector: string): string {
  const list = parseSelectorList(selector).map((c) => ({
    ...c,
    compounds: c.compounds.map((k) => {
      const parts = k.parts.filter((p) => p.t !== "pseudo-element");
      return { parts: parts.length ? parts : [{ t: "universal" as const }] };
    }),
  }));
  return serializeList(list);
}

// Flattens the library sheet's style rules in CSSOM order, with whether
// their conditions hold here; and rewrites their states to attributes.
const RULES = `((path, stateRe) => {
  const sheet = Array.from(document.styleSheets).find((s) => s.href && new URL(s.href).pathname === "/" + path);
  if (!sheet) return null;
  const re = new RegExp(stateRe, "g");
  const out = [];
  const visit = (list, holds) => {
    for (const r of list) {
      if (r instanceof CSSStyleRule) {
        out.push({ rule: r, holds, selector: r.selectorText });
        if (r.cssRules && r.cssRules.length) visit(r.cssRules, holds);
        continue;
      }
      if (r instanceof CSSKeyframesRule) continue;
      let ok = holds;
      if (r instanceof CSSMediaRule) ok = ok && matchMedia(r.media.mediaText).matches;
      else if (r instanceof CSSSupportsRule) ok = ok && CSS.supports(r.conditionText);
      if (r.cssRules) visit(r.cssRules, ok);
    }
  };
  visit(sheet.cssRules, true);
  for (const o of out) o.rule.selectorText = o.selector.replace(re, (_, s) => "[data-cr-" + s + "]");
  window.__crRules = out;
  return out.map((o) => [o.selector, o.holds]);
})`;

// One page: each rule that styles an element here, each of its longhands
// removed and the styled elements read again.
const MUTATE = `((plans) => {
  const rules = window.__crRules;
  const out = [];
  for (const [i, relaxed, target, states, pseudo] of plans) {
    const { rule, holds } = rules[i];
    if (!holds) continue;
    let els;
    try { els = document.querySelectorAll(relaxed); } catch { continue; }
    if (!els.length) continue;
    const styled = () => Array.from(els).filter((e) => { try { return e.matches(target); } catch { return false; } });
    // Without states first: one under :not() applies when it's off.
    let targets = styled();
    const set = [];
    if (!targets.length) {
      for (const { prefix, names } of states) {
        let hits = [];
        try { hits = document.querySelectorAll(prefix); } catch {}
        for (const h of hits) for (const n of names) {
          if (!h.hasAttribute("data-cr-" + n)) { h.setAttribute("data-cr-" + n, ""); set.push([h, n]); }
        }
      }
      targets = styled();
    }
    if (targets.length) {
      const covered = [];
      const names = Array.from(rule.style);
      for (const p of names) {
        const value = rule.style.getPropertyValue(p);
        const priority = rule.style.getPropertyPriority(p);
        const read = () => targets.map((e) => getComputedStyle(e, pseudo).getPropertyValue(p));
        const before = read();
        rule.style.removeProperty(p);
        const after = read();
        rule.style.setProperty(p, value, priority);
        if (before.some((v, j) => v !== after[j])) covered.push(p);
      }
      out.push([i, covered, names]);
    }
    for (const [h, n] of set) h.removeAttribute("data-cr-" + n);
  }
  return out;
})`;

/**
 * Per CSSOM style rule of the library stylesheet: the pages it styles an
 * element on, and which of its longhands change a value there when
 * removed. Rules in `@media` or `@supports` that don't hold at the run's
 * viewports are left alone.
 */
export async function mutationCoverage(opts: CoverageOptions): Promise<{
  rules: RuleCoverage[];
  pages: number;
  ms: number;
  notReady: string[];
}> {
  const path = swappedSheet(opts.dir, opts.sheetMarker).split("\\").join("/");
  const server = serveFixtures(opts.dir, {
    swap: { marker: opts.sheetMarker, css: opts.css },
  });
  let plans: [number, string, string, object[], string | null][] | null = null;
  let rules: RuleCoverage[] = [];
  try {
    const r = await visitPages(
      { ...opts, baseUrl: server.url },
      async (view, job) => {
        await preparePage(view, {
          states: false,
          emulate: opts.emulate,
          settleMs: opts.settleMs,
        });
        const found = await view.evaluate<[string, boolean][] | null>(
          `${RULES}(${JSON.stringify(path)}, ${JSON.stringify(STATE_RE.source)})`,
        );
        if (!found) return;
        const selectors = found.map(([s]) => s);
        if (!plans) {
          rules = selectors.map((selector) => ({
            selector,
            pages: [],
            held: false,
            covered: [],
            longhands: [],
          }));
          plans = selectors.map((s, i) => {
            const states = stateSets(s).map((t) => ({
              ...t,
              prefix: asAttrs(t.prefix),
            }));
            let relaxed = "*";
            let target = "*";
            try {
              relaxed = parseSelectorList(s)
                .map((c) => relaxSelector(serializeList([c])))
                .join(", ");
              target = asAttrs(matchable(s));
            } catch {}
            return [i, relaxed, target, states, PSEUDO_RE.exec(s)?.[0] ?? null];
          });
        }
        found.forEach(([, holds], i) => {
          if (holds) rules[i].held = true;
        });
        const done = await view.evaluate<[number, string[], string[]][]>(
          `${MUTATE}(${JSON.stringify(plans)})`,
        );
        for (const [i, covered, longhands] of done) {
          const rule = rules[i];
          rule.pages.push(job.label);
          rule.covered = [...new Set([...rule.covered, ...covered])];
          rule.longhands = longhands;
        }
      },
    );
    return { rules, ...r };
  } finally {
    server.stop();
  }
}
