/**
 * Cascade replay and aggregation for rung 2. Each observation (an element,
 * pseudo-element or forced state) is the list of library rules matched on
 * it in normal cascade order (layer, specificity, scope, source order), as
 * CDP's `matchedCSSRules` or `cascadeOrder` gives it. Per longhand, the
 * winner is the `!important` declaration in the earliest layer, else the
 * last normal one.
 *
 * A shorthand expands to its longhands (CDP's `longhandProperties`, or the
 * text-less entries CDP lists beside it, or the engine's CSSOM in the `dom`
 * engine) and counts as won if it wins any of them: a partial override
 * still shows.
 *
 * Rule identity for "never matched" is `context + selector`, so a selector
 * authored twice in one context counts as matched if either copy is. That
 * under-reports, which is the safe side for evidence.
 */

import { SHORTHANDS } from "./shorthands";

/** A `Protocol.CSS.CSSProperty` subset: CDP responses fit as they are. */
export interface CdpProperty {
  name: string;
  value: string;
  important?: boolean;
  /** Set by CDP on longhands it derived from an authored shorthand. */
  implicit?: boolean;
  text?: string;
  parsedOk?: boolean;
  disabled?: boolean;
  longhandProperties?: { name: string; value: string; important?: boolean }[];
}

export interface Declaration {
  property: string;
  value: string;
  important: boolean;
  /** What it sets, for replay. */
  longhands: string[];
}

export interface MatchedRule {
  /** `@media`, `@supports`, `@container`, outermost first, joined with " / ". */
  context: string;
  selector: string;
  declarations: Declaration[];
  /** `Rule.layerRank`; omitted when unlayered. */
  layerRank?: number;
}

const VENDOR_PREFIX_RE = /^-(?:webkit|moz|ms)-(.+)$/;

const usable = (p: CdpProperty) => !p.disabled && p.parsedOk !== false;

/**
 * The standard property a vendor alias sets, when CDP lists it text-less
 * beside the alias (`-webkit-user-select` sets `user-select`).
 */
function aliasTarget(
  name: string,
  cssProperties: CdpProperty[],
): string | undefined {
  const target = VENDOR_PREFIX_RE.exec(name)?.[1];
  if (!target) return undefined;
  return cssProperties.some((p) => p.name === target && !p.text && usable(p))
    ? target
    : undefined;
}

/**
 * The authored declarations of a matched rule, from CDP's `cssProperties`:
 * entries with `text` (the longhands CDP derives from a shorthand have
 * none), minus disabled and unparsed ones.
 */
export function authoredDeclarations(
  cssProperties: CdpProperty[],
): Declaration[] {
  const out: Declaration[] = [];
  for (const prop of cssProperties) {
    if (!usable(prop) || !prop.text) continue;
    let longhands: string[];
    if (prop.longhandProperties && prop.longhandProperties.length > 0) {
      longhands = prop.longhandProperties.map((l) => l.name);
    } else {
      const set = SHORTHANDS[prop.name];
      const siblings = set
        ? cssProperties.filter(
            (p) => !p.text && usable(p) && set.includes(p.name),
          )
        : [];
      longhands =
        siblings.length > 0
          ? siblings.map((p) => p.name)
          : [aliasTarget(prop.name, cssProperties) ?? prop.name];
    }
    out.push({
      property: prop.name,
      value: prop.value,
      important: Boolean(prop.important),
      longhands,
    });
  }
  return out;
}

const WS_RUN_RE = /\s+/g;

/** Context text with whitespace collapsed. */
export function normalizeContext(context: string): string {
  return context.replace(WS_RUN_RE, " ").trim();
}

// ---------------------------------------------------------------------------
// Cascade replay

type Loc = [ruleIndex: number, declIndex: number];

/** Longhand -> the winning declaration in one observation (see the header). */
export function cascadeWinners(rules: MatchedRule[]): Map<string, Loc> {
  const important = new Map<string, Loc>();
  const importantRank = new Map<string, number>();
  const normal = new Map<string, Loc>();
  for (let ri = 0; ri < rules.length; ri++) {
    const rule = rules[ri];
    const rank = rule.layerRank ?? Number.POSITIVE_INFINITY;
    for (let di = 0; di < rule.declarations.length; di++) {
      const decl = rule.declarations[di];
      for (const lh of decl.longhands) {
        if (!decl.important) normal.set(lh, [ri, di]);
        else if (rank <= (importantRank.get(lh) ?? rank)) {
          important.set(lh, [ri, di]);
          importantRank.set(lh, rank);
        }
      }
    }
  }
  for (const [lh, loc] of important) normal.set(lh, loc);
  return normal;
}

const wonAny = (
  winners: Map<string, Loc>,
  decl: Declaration,
  ri: number,
  di: number,
) =>
  decl.longhands.some((lh) => {
    const w = winners.get(lh);
    return w !== undefined && w[0] === ri && w[1] === di;
  });

/** Per declaration, whether it won any of its longhands. */
export function replayWins(rules: MatchedRule[]): boolean[][] {
  const winners = cascadeWinners(rules);
  return rules.map((rule, ri) =>
    rule.declarations.map((decl, di) => wonAny(winners, decl, ri, di)),
  );
}

// ---------------------------------------------------------------------------
// Aggregation

export interface DeclarationStats {
  context: string;
  selector: string;
  property: string;
  value: string;
  important: boolean;
  matched: number;
  won: number;
  /** Winning rule (context + selector) -> losses to it. */
  lostTo: Record<string, number>;
}

export interface UsageAggregate {
  declarations: Map<string, DeclarationStats>;
  /** `${context}\0${selector}` of every rule that matched. */
  matchedRuleKeys: Set<string>;
  observations: number;
}

export function createAggregate(): UsageAggregate {
  return {
    declarations: new Map(),
    matchedRuleKeys: new Set(),
    observations: 0,
  };
}

const ruleKey = (r: MatchedRule): string => `${r.context}\0${r.selector}`;
const declKey = (r: MatchedRule, d: Declaration): string =>
  `${r.context}\0${r.selector}\0${d.property}\0${d.value}\0${d.important}`;
const ruleLabel = (r: MatchedRule): string =>
  r.context ? `${r.context} ${r.selector}` : r.selector;

function statsFor(
  agg: UsageAggregate,
  rule: MatchedRule,
  decl: Declaration,
): DeclarationStats {
  const key = declKey(rule, decl);
  const existing = agg.declarations.get(key);
  if (existing) return existing;
  const stats: DeclarationStats = {
    context: rule.context,
    selector: rule.selector,
    property: decl.property,
    value: decl.value,
    important: decl.important,
    matched: 0,
    won: 0,
    lostTo: {},
  };
  agg.declarations.set(key, stats);
  return stats;
}

/** Records one observation: the library rules matched, in cascade order. */
export function recordObservation(
  agg: UsageAggregate,
  rules: MatchedRule[],
): void {
  agg.observations++;
  const winners = cascadeWinners(rules);
  for (let ri = 0; ri < rules.length; ri++) {
    const rule = rules[ri];
    agg.matchedRuleKeys.add(ruleKey(rule));
    for (let di = 0; di < rule.declarations.length; di++) {
      const decl = rule.declarations[di];
      const stats = statsFor(agg, rule, decl);
      stats.matched++;
      if (wonAny(winners, decl, ri, di)) {
        stats.won++;
        continue;
      }
      // The loss goes to the winner of the first longhand: enough to spot a
      // recurring override.
      const winnerLoc = winners.get(decl.longhands[0]);
      if (!winnerLoc) continue;
      const label = ruleLabel(rules[winnerLoc[0]]);
      stats.lostTo[label] = (stats.lostTo[label] ?? 0) + 1;
    }
  }
}

export const bytesOf = (d: { property: string; value: string }): number =>
  d.property.length + d.value.length + 2;

// Runs emulate `prefers-reduced-motion`, so a `transition` always loses to
// its `transition: none` there. A preference-gated rule is an alternative,
// not an override.
const PREFERENCE_MEDIA_RE =
  /prefers-reduced-motion|prefers-contrast|forced-colors/;

/** A loss that only happens because of an emulated user preference. */
const losesOnlyToPreferenceMedia = (d: DeclarationStats): boolean => {
  const winners = Object.keys(d.lostTo);
  return (
    winners.length > 0 && winners.every((w) => PREFERENCE_MEDIA_RE.test(w))
  );
};

/** Declarations that matched at least once but never won anywhere. */
export function deadInFixtures(agg: UsageAggregate): DeclarationStats[] {
  return [...agg.declarations.values()].filter(
    (d) => d.matched > 0 && d.won === 0 && !losesOnlyToPreferenceMedia(d),
  );
}

/** Dead declarations that always lose to the same single rule. */
export function foldCandidates(agg: UsageAggregate): DeclarationStats[] {
  return deadInFixtures(agg).filter((d) => Object.keys(d.lostTo).length === 1);
}

// ---------------------------------------------------------------------------
// Inventory: every rule of the sheet, matched or not

export interface InventoryRule {
  context: string;
  selector: string;
  declText: string;
  bytes: number;
}

/** The inventory from `parseRules` output (one entry per selector). */
export function inventoryFromRules(
  rules: { context: string; selector: string; decls: Map<string, string> }[],
): InventoryRule[] {
  return rules.map((r) => {
    const entries = [...r.decls];
    return {
      context: normalizeContext(r.context),
      selector: r.selector,
      declText: entries.map(([p, v]) => `${p}: ${v}`).join("; "),
      bytes: entries.reduce(
        (n, [property, value]) => n + bytesOf({ property, value }),
        0,
      ),
    };
  });
}

/** Rules no observation matched. */
export function neverMatchedRules(
  agg: UsageAggregate,
  inventory: InventoryRule[],
): InventoryRule[] {
  return inventory.filter(
    (r) => !agg.matchedRuleKeys.has(`${r.context}\0${r.selector}`),
  );
}

// ---------------------------------------------------------------------------
// Summary

export interface Summary {
  fixtures: number;
  themes: number;
  viewports: number;
  observations: number;
  rulesTotal: number;
  rulesMatched: number;
  declarationsTotal: number;
  declarationsEverWon: number;
  declarationsNeverWon: number;
  bytesNeverWon: number;
  bytesUnmatchedRules: number;
}

export function summarize(
  agg: UsageAggregate,
  inventory: InventoryRule[],
  fixtures: number,
  themes: number,
  viewports = 1,
): Summary {
  const declarations = [...agg.declarations.values()];
  const neverWon = deadInFixtures(agg);
  const unmatched = neverMatchedRules(agg, inventory);
  return {
    fixtures,
    themes,
    viewports,
    observations: agg.observations,
    rulesTotal: inventory.length,
    rulesMatched: agg.matchedRuleKeys.size,
    declarationsTotal: declarations.length,
    declarationsEverWon: declarations.filter((d) => d.won > 0).length,
    declarationsNeverWon: neverWon.length,
    bytesNeverWon: neverWon.reduce((n, d) => n + bytesOf(d), 0),
    bytesUnmatchedRules: unmatched.reduce((n, r) => n + r.bytes, 0),
  };
}

/** Folds `from` into `into`, as when merging per-tab aggregates. */
export function mergeAggregate(
  into: UsageAggregate,
  from: UsageAggregate,
): void {
  into.observations += from.observations;
  for (const k of from.matchedRuleKeys) into.matchedRuleKeys.add(k);
  for (const [key, d] of from.declarations) {
    const existing = into.declarations.get(key);
    if (!existing) {
      into.declarations.set(key, { ...d, lostTo: { ...d.lostTo } });
      continue;
    }
    existing.matched += d.matched;
    existing.won += d.won;
    for (const [w, n] of Object.entries(d.lostTo))
      existing.lostTo[w] = (existing.lostTo[w] ?? 0) + n;
  }
}
