// The pure half of the `dom` usage engine: the browser only matches
// selectors and expands declarations.

import { canonicalValue, propertyName } from "./cascade";
import { type Decl, parseStylesheet } from "./parse";
import { placeRules } from "./placement";
import {
  compareSpecificity,
  type Specificity,
  serialize,
  specificity,
} from "./selector";
import type { Declaration, MatchedRule } from "./usage";

export interface LibraryRule {
  context: string;
  /** `Rule.layerRank`, or undefined when unlayered. */
  layerRank: number | undefined;
  scoped: boolean;
  /** Selector text without formatting, to find the rule in the CSSOM. */
  loose: string;
  selectors: { canon: string; spec: Specificity }[];
  decls: Decl[];
}

const WS_QUOTES_RE = /[\s"']+/g;
const DOUBLE_COLON_RE = /::/g;

const looseSelector = (s: string) =>
  s.replace(WS_QUOTES_RE, "").replace(DOUBLE_COLON_RE, ":").toLowerCase();

/** The sheet's style rules in CSSOM order. */
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

export interface EngineDeclInfo {
  /** Property -> the longhands it sets in this engine. */
  longhands: Record<string, string[]>;
  /** Per pair: whether the engine accepts the value. */
  valid: boolean[];
}

/**
 * The distinct `[property, value]` pairs to ask the engine about, and a
 * function from its answers to each rule's valid, expanded declarations.
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
          const prop = propertyName(d.property);
          const longhands = info.longhands[prop];
          ds.push({
            property: prop,
            value: canonicalValue(d.raw, false, prop),
            important: d.important,
            longhands: longhands?.length ? longhands : [prop],
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
 * `matches` (`[cssomRuleIndex, ...matchingSelectorIndexes]`) in normal cascade
 * order: layer, heaviest matching selector, scoped before unscoped (scope
 * roots aren't evaluated), source order. Unaligned or empty rules are left out.
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
