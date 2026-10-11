// `crassus tokens`: which design tokens drive which properties on the
// fixtures, from runtime evidence: every token set to a sentinel, and each
// value checked for it. Tokens nothing follows are unused; colors that
// follow none are hard-coded.
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
  /** Colors that follow no token, by property and value, most common first. */
  hardCoded: {
    property: string;
    value: string;
    count: number;
    examples: { page: string; path: string }[];
  }[];
  pages: number;
  ms: number;
  /** Pages that never matched `readySelector` (traced anyway). */
  notReady: string[];
}

const COLOR_RE = /(?:^|-)color$|^(?:fill|stroke)$/;
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
  const hard = new Map<string, TokenReport["hardCoded"][number]>();
  const r = await visitPages(opts, async (view, job) => {
    const { snapshot, tokens, tokenNames } = await capturePage(view, {
      states: false,
      emulate: opts.emulate,
      settleMs: opts.settleMs,
      tokens: opts.prefix,
    });
    for (const n of tokenNames ?? []) traced.add(n);
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
        const key = `${property}\0${value}`;
        const h = hard.get(key) ?? { property, value, count: 0, examples: [] };
        h.count++;
        if (h.examples.length < 3) h.examples.push({ page: job.label, path });
        hard.set(key, h);
      }
    }
  });
  const usedOut: Record<string, TokenUse> = {};
  for (const [name, { pageSet, ...u }] of [...used].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  ))
    usedOut[name] = { ...u, pages: [...pageSet].sort() };
  return {
    traced: traced.size,
    used: usedOut,
    unused: [...traced].filter((n) => !used.has(n)).sort(),
    hardCoded: [...hard.values()].sort((a, b) => b.count - a.count),
    pages: r.pages,
    ms: r.ms,
    notReady: r.notReady,
  };
}
