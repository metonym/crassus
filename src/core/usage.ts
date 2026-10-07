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
  /** See `Rule.context`. */
  context: string;
  selector: string;
  declarations: Declaration[];
  /** `Rule.layerRank`; omitted when unlayered. */
  layerRank?: number;
}

const VENDOR_PREFIX_RE = /^-(?:webkit|moz|ms)-(.+)$/;

const usable = (p: CdpProperty) => !p.disabled && p.parsedOk !== false;

/** The standard property a vendor alias sets, when CDP lists it text-less beside it. */
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
 * A matched rule's authored declarations: the `cssProperties` with `text`
 * (CDP's derived longhands have none), minus disabled and unparsed ones.
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

export function normalizeContext(context: string): string {
  return context.replace(WS_RUN_RE, " ").trim();
}

type Loc = [ruleIndex: number, declIndex: number];

/**
 * Longhand -> the winning declaration: the `!important` one in the earliest
 * layer, else the last normal one.
 */
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

// A shorthand wins if it wins any longhand, so a partial override still shows.
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

const ruleKey = (r: { context: string; selector: string }): string =>
  `${r.context}\0${r.selector}`;
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

/**
 * Records one observation (element, pseudo-element or forced state): its
 * matched library rules in cascade order, as CDP or `cascadeOrder` gives them.
 */
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
      // Charged to the first longhand's winner: enough to spot a recurring override.
      const winnerLoc = winners.get(decl.longhands[0]);
      if (!winnerLoc) continue;
      const label = ruleLabel(rules[winnerLoc[0]]);
      stats.lostTo[label] = (stats.lostTo[label] ?? 0) + 1;
    }
  }
}

export const bytesOf = (d: { property: string; value: string }): number =>
  d.property.length + d.value.length + 2;

// Runs emulate `prefers-reduced-motion`, where `transition` always loses to
// `transition: none`: a preference-gated rule is an alternative, not an override.
const PREFERENCE_MEDIA_RE =
  /prefers-reduced-motion|prefers-contrast|forced-colors/;

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

export interface InventoryRule {
  context: string;
  selector: string;
  declText: string;
  bytes: number;
}

/** Every rule of the sheet, matched or not, from `parseRules` output. */
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

/**
 * Rules no observation matched. A selector authored twice in one context is
 * matched if either copy is: that under-reports, the safe side for evidence.
 */
export function neverMatchedRules(
  agg: UsageAggregate,
  inventory: InventoryRule[],
): InventoryRule[] {
  return inventory.filter((r) => !agg.matchedRuleKeys.has(ruleKey(r)));
}

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

/** Folds `from` into `into` (per-tab aggregates). */
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
