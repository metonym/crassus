// `crassus tokens`: which design tokens drive which properties on the
// fixtures, from runtime evidence: every token set to a sentinel, and each
// value checked for it. Tokens nothing follows are unused; colors that
// follow none are hard-coded.
import { unseen } from "../core/fold";
import { resolvePath } from "../page/resolve-path";
import { capturePage } from "./snapshot";
import { type VisitOptions, visitPages } from "./view";

interface TokenUse {
  /** Elements with a property that follows it. */
  elements: number;
  /** Property -> elements. */
  properties: Record<string, number>;
  pages: string[];
}

export interface TokenReport {
  /** Tokens traced: those with a color, length or font-stack value. */
  traced: number;
  used: Record<string, TokenUse>;
  /** Traced tokens no property followed on any page. */
  unused: string[];
  /**
   * Colors that follow no token where an author rule (or style attribute)
   * sets them, by property and value, most common first.
   */
  hardCoded: ColorUse[];
  /** Colors that follow no token where no author rule sets them: the user agent's. */
  uaDefaults: ColorUse[];
  /** Per list, the elements left out of it. */
  omitted: { hardCoded: Omitted; uaDefaults: Omitted };
  pages: number;
  ms: number;
  /** Pages that never matched `readySelector` (traced anyway). */
  notReady: string[];
}

interface ColorUse {
  property: string;
  value: string;
  /** Elements listed. */
  count: number;
  examples: { page: string; path: string }[];
  /** Elements with it left out: no one sees them, or they inherit it. */
  omitted?: Omitted;
}

interface Omitted {
  invisible: number;
  inherited: number;
}

/** A list's entries with elements listed, most first, and what all left out. */
function listed(uses: Map<string, ColorUse>) {
  const omitted: Omitted = { invisible: 0, inherited: 0 };
  for (const u of uses.values()) {
    omitted.invisible += u.omitted?.invisible ?? 0;
    omitted.inherited += u.omitted?.inherited ?? 0;
  }
  return {
    list: [...uses.values()]
      .filter((u) => u.count > 0)
      .sort((a, b) => b.count - a.count),
    omitted,
  };
}

const COLOR_RE = /(?:^|-)color$|^(?:fill|stroke)$/;
const INHERITED = new Set([
  "color",
  "caret-color",
  "fill",
  "stroke",
  "-webkit-text-fill-color",
  "-webkit-text-stroke-color",
  "text-emphasis-color",
]);
const PSEUDO_KEY_RE = /::(?:before|after)$/;

// Per [path, property]: whether an author rule whose conditions hold, or the
// element's style attribute, declares it on the element.
const AUTHORED = `((cands) => {
  const resolvePath = ${resolvePath.toString()};
  const rules = [];
  const visit = (list, holds) => {
    for (const r of list) {
      if (r instanceof CSSStyleRule) { if (holds) rules.push(r); }
      let ok = holds;
      if (r instanceof CSSMediaRule) ok = ok && matchMedia(r.media.mediaText).matches;
      else if (r instanceof CSSSupportsRule) ok = ok && CSS.supports(r.conditionText);
      if (r.cssRules) visit(r.cssRules, ok);
    }
  };
  for (const sheet of document.styleSheets) {
    try { visit(sheet.cssRules, true); } catch {}
  }
  const byProperty = new Map();
  const authored = (property) => {
    let set = byProperty.get(property);
    if (set) return set;
    set = new Set();
    for (const r of rules) {
      if (!r.style.getPropertyValue(property)) continue;
      try { for (const el of document.querySelectorAll(r.selectorText)) set.add(el); } catch {}
    }
    byProperty.set(property, set);
    return set;
  };
  return cands.map(([path, property]) => {
    const el = resolvePath(path, document.documentElement);
    return !el || authored(property).has(el) || el.style.getPropertyValue(property) !== "";
  });
})`;
const CLEAR = new Set(["transparent", "rgba(0, 0, 0, 0)", "none", ""]);
// Physical names only; followers of `color` count once, as `color`.
const LOGICAL_RE = /-(?:block|inline)-/;
const PAINT_RE = /^(?:fill|stroke)$/;
const SVG_RE =
  /(?:^|>)(?:svg|path|circle|rect|g|use|polygon|polyline|line|ellipse|text)(?:[.[]|$)/;

/** Traces `prefix` tokens over the pages as they're served. */
export async function traceTokens(
  opts: VisitOptions & { prefix: string; settleMs?: number },
): Promise<TokenReport> {
  const used = new Map<string, TokenUse & { pageSet: Set<string> }>();
  const traced = new Set<string>();
  const hard = new Map<string, ColorUse>();
  const ua = new Map<string, ColorUse>();
  const entry = (
    into: Map<string, ColorUse>,
    property: string,
    value: string,
  ) => {
    const key = `${property}\0${value}`;
    let h = into.get(key);
    if (!h) {
      h = { property, value, count: 0, examples: [] };
      into.set(key, h);
    }
    return h;
  };
  const r = await visitPages(opts, async (view, job) => {
    const { snapshot, tokens, tokenNames } = await capturePage(view, {
      states: false,
      emulate: opts.emulate,
      settleMs: opts.settleMs,
      tokens: opts.prefix,
    });
    for (const n of tokenNames ?? []) traced.add(n);
    const cands: [string, string, string, boolean][] = [];
    for (const [path, record] of Object.entries(snapshot)) {
      const follows = tokens?.[path] ?? {};
      const seen = new Set<string>();
      for (const [property, list] of Object.entries(follows))
        for (const name of list) {
          let u = used.get(name);
          if (!u) {
            u = { elements: 0, properties: {}, pages: [], pageSet: new Set() };
            used.set(name, u);
          }
          if (!seen.has(name)) u.elements++;
          seen.add(name);
          u.properties[property] = (u.properties[property] ?? 0) + 1;
          u.pageSet.add(job.label);
        }
      // A color no one sees (a visually hidden input's) is no finding.
      const hidden = Boolean(unseen(snapshot, path));
      for (const [property, value] of Object.entries(record)) {
        if (!COLOR_RE.test(property) || follows[property] || CLEAR.has(value))
          continue;
        if (LOGICAL_RE.test(property)) continue;
        if (property !== "color" && value === record.color) continue;
        // `fill` and `stroke` only paint SVG.
        if (
          PAINT_RE.test(property) &&
          !SVG_RE.test(path.split(">").at(-1) ?? "")
        )
          continue;
        cands.push([path, property, value, hidden]);
      }
    }
    const authored = await view.evaluate<boolean[]>(
      `${AUTHORED}(${JSON.stringify(cands.map(([path, property]) => [path.replace(PSEUDO_KEY_RE, ""), property]))})`,
    );
    const setBy = new Map(
      cands.map(([path, property], i) => [`${path}\0${property}`, authored[i]]),
    );
    const parentOf = (path: string) =>
      PSEUDO_KEY_RE.test(path)
        ? path.replace(PSEUDO_KEY_RE, "")
        : path.slice(0, path.lastIndexOf(">"));
    // Where an inherited value is set: an author rule on the nearest
    // ancestor that doesn't inherit it, or else the user agent.
    const authorUp = (path: string, property: string, value: string) => {
      for (let p = parentOf(path); p; p = parentOf(p)) {
        if (setBy.get(`${p}\0${property}`)) return true;
        if (snapshot[parentOf(p)]?.[property] !== value) return false;
      }
      return false;
    };
    for (const [i, [path, property, value, hidden]] of cands.entries()) {
      const pseudo = PSEUDO_KEY_RE.test(path);
      const inherited =
        INHERITED.has(property) &&
        snapshot[parentOf(path)]?.[property] === value;
      const set = authored[i] && !pseudo;
      // A pseudo-element's own color is an author's: no user agent sets one.
      const into =
        set ||
        (pseudo && !inherited) ||
        (inherited && authorUp(path, property, value))
          ? hard
          : ua;
      // Left out, and counted as such: what no one sees, and what's
      // inherited with the same value (counted where it's set).
      const h = entry(into, property, value);
      const left = hidden
        ? "invisible"
        : inherited && !set
          ? "inherited"
          : null;
      if (left) {
        h.omitted ??= { invisible: 0, inherited: 0 };
        h.omitted[left]++;
      } else {
        h.count++;
        if (h.examples.length < 3) h.examples.push({ page: job.label, path });
      }
    }
  });
  const hardList = listed(hard);
  const uaList = listed(ua);
  const usedOut: Record<string, TokenUse> = {};
  for (const [name, { pageSet, ...u }] of [...used].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  ))
    usedOut[name] = { ...u, pages: [...pageSet].sort() };
  return {
    traced: traced.size,
    used: usedOut,
    unused: [...traced].filter((n) => !used.has(n)).sort(),
    hardCoded: hardList.list,
    uaDefaults: uaList.list,
    omitted: { hardCoded: hardList.omitted, uaDefaults: uaList.omitted },
    ...r,
  };
}
