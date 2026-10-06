/**
 * The pure half of the `dom` usage engine: line up the rules a browser kept
 * (its CSSOM) with the parsed library sheet, and turn one element's matched
 * rules into cascade-ordered observations for `recordObservation`. The
 * browser side only matches selectors and expands declarations.
 */

import { canonicalValue } from "./cascade";
import { type Decl, parseStylesheet } from "./parse";
import { placeRules } from "./placement";
import {
  compareSpecificity,
  type Specificity,
  serialize,
  specificity,
} from "./selector";
import type { Declaration, MatchedRule } from "./usage";

/** A style rule of the library sheet, as the browser's CSSOM lists it. */
export interface LibraryRule {
  context: string;
  /** `Rule.layerRank`, or undefined when unlayered. */
  layerRank: number | undefined;
  scoped: boolean;
  /** Selector text with formatting removed, to find the rule in the CSSOM. */
  loose: string;
  selectors: { canon: string; spec: Specificity }[];
  decls: Decl[];
}

const WS_QUOTES_RE = /[\s"']+/g;
const DOUBLE_COLON_RE = /::/g;

/** Selector text with whitespace, quotes and `::` vs `:` differences removed. */
const looseSelector = (s: string) =>
  s.replace(WS_QUOTES_RE, "").replace(DOUBLE_COLON_RE, ":").toLowerCase();

/** The library sheet's style rules in CSSOM order (keyframes left out). */
export function libraryRules(css: string): LibraryRule[] {
  const out: LibraryRule[] = [];
  for (const p of placeRules(parseStylesheet(css))) {
    if (p.keyframes) continue;
    out.push({
      context: p.context,
      layerRank: p.layer.name ? p.layer.rank : undefined,
      scoped: p.scope !== "",
      loose: looseSelector(p.text),
      selectors: p.selectors.map(({ complex }) => ({
        canon: serialize(complex),
        spec: specificity(complex),
      })),
      decls: p.decls,
    });
  }
  return out;
}

// How far ahead to look for a CSSOM rule among the parsed ones.
const ALIGN_WINDOW = 200;

/**
 * The parsed rule behind each CSSOM rule, by selector text. CSSOM rules are
 * a subsequence of the source rules (the engine drops what it can't parse);
 * a rule not found within the next ALIGN_WINDOW parsed rules is undefined.
 */
export function alignRules(
  cssomSelectors: string[],
  parsed: LibraryRule[],
): (LibraryRule | undefined)[] {
  const out: (LibraryRule | undefined)[] = [];
  let j = 0;
  for (const sel of cssomSelectors) {
    const key = looseSelector(sel);
    let k = j;
    const limit = Math.min(parsed.length, j + ALIGN_WINDOW);
    while (k < limit && parsed[k].loose !== key) k++;
    if (k < limit) {
      out.push(parsed[k]);
      j = k + 1;
    } else out.push(undefined);
  }
  return out;
}

/** What the engine says about each `[property, value]` pair it was asked about. */
export interface EngineDeclInfo {
  /** Property -> the longhands it sets in this engine. */
  longhands: Record<string, string[]>;
  /** Per pair: whether the engine accepts the value. */
  valid: boolean[];
}

/**
 * The distinct `[property, value]` pairs of the aligned rules, to ask the
 * engine about, and a function from its answers to each rule's declarations
 * (invalid ones dropped, longhands expanded).
 */
export function engineDeclarations(aligned: (LibraryRule | undefined)[]): {
  pairs: [string, string][];
  resolve: (info: EngineDeclInfo) => (rule: LibraryRule) => Declaration[];
} {
  const pairs: [string, string][] = [];
  const pairIndex = new Map<string, number>();
  for (const p of aligned) {
    for (const d of p?.decls ?? []) {
      const k = `${d.property}\0${d.raw}`;
      if (!pairIndex.has(k)) {
        pairIndex.set(k, pairs.length);
        pairs.push([d.property.toLowerCase(), d.raw]);
      }
    }
  }
  const resolve = (info: EngineDeclInfo) => {
    const cache = new Map<LibraryRule, Declaration[]>();
    return (rule: LibraryRule) => {
      let ds = cache.get(rule);
      if (!ds) {
        ds = [];
        for (const d of rule.decls) {
          if (!info.valid[pairIndex.get(`${d.property}\0${d.raw}`) ?? -1])
            continue;
          const prop = d.property.startsWith("--")
            ? d.property
            : d.property.toLowerCase();
          ds.push({
            property: prop,
            value: canonicalValue(d.raw, false, prop),
            important: d.important,
            longhands: info.longhands[prop]?.length
              ? info.longhands[prop]
              : [prop],
          });
        }
        cache.set(rule, ds);
      }
      return ds;
    };
  };
  return { pairs, resolve };
}

/**
 * One observation's matched rules in normal cascade order: layer,
 * specificity (of the heaviest matching selector), scope proximity (scoped
 * before unscoped only: scope roots aren't evaluated), then source order.
 * `matches` holds `[cssomRuleIndex, ...matchingSelectorIndexes]`; rules
 * that didn't align or have no valid declarations are left out.
 */
export function cascadeOrder(
  matches: number[][],
  aligned: (LibraryRule | undefined)[],
  declarations: (rule: LibraryRule) => Declaration[],
): MatchedRule[] {
  const list: {
    rule: MatchedRule;
    layer: number;
    spec: Specificity;
    scoped: boolean;
    order: number;
  }[] = [];
  for (const [ri, ...sels] of matches) {
    const p = aligned[ri];
    if (!p) continue;
    const decls = declarations(p);
    if (decls.length === 0) continue;
    let spec: Specificity = [0, 0, 0];
    for (const s of sels) {
      const sp = p.selectors[s]?.spec;
      if (sp && compareSpecificity(sp, spec) > 0) spec = sp;
    }
    const rule: MatchedRule = {
      context: p.context,
      selector: p.selectors[sels[0]]?.canon ?? "",
      declarations: decls,
    };
    if (p.layerRank !== undefined) rule.layerRank = p.layerRank;
    list.push({
      rule,
      layer: p.layerRank ?? Number.POSITIVE_INFINITY,
      spec,
      scoped: p.scoped,
      order: ri,
    });
  }
  list.sort(
    (a, b) =>
      (a.layer === b.layer ? 0 : a.layer < b.layer ? -1 : 1) ||
      compareSpecificity(a.spec, b.spec) ||
      Number(a.scoped) - Number(b.scoped) ||
      a.order - b.order,
  );
  return list.map((x) => x.rule);
}
