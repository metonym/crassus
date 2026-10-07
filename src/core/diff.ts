import {
  candidates,
  coMatchable,
  conflictingProps,
  indexBySubject,
  matchContextMoves,
  pairOff,
  type Rule,
  samePlacement,
  wins,
} from "./cascade";
import { intersects, pushTo } from "./util";

/** The relations `diffWith` uses: swapped to compare implementations. */
export interface CascadeLib {
  candidates: typeof candidates;
  coMatchable: typeof coMatchable;
  conflictingProps: typeof conflictingProps;
  indexBySubject: typeof indexBySubject;
  matchContextMoves: typeof matchContextMoves;
  wins: typeof wins;
}

const DEFAULT_LIB: CascadeLib = {
  candidates,
  coMatchable,
  conflictingProps,
  indexBySubject,
  matchContextMoves,
  wins,
};

export interface Flip {
  rule: Rule;
  other: Rule;
  otherBase: Rule | undefined;
  prop: string;
  before: "wins" | "loses";
  after: "wins" | "loses";
}

export interface CascadeDiff {
  removed: Rule[];
  added: Rule[];
  /** Head rule -> base rule with the same declarations and a new selector. */
  rewrites: Map<Rule, Rule>;
  /** Added rules that aren't rewrites or moves. */
  newRules: Rule[];
  /** Removed rules that aren't rewritten or moved. */
  dropped: Rule[];
  /** Head rule -> base rule, same selector and declarations, new context, layer or scope. */
  contextMoves: Map<Rule, Rule>;
  /** Unchanged rules that moved relative to the others. */
  movedHead: Set<Rule>;
  flips: Flip[];
  /** Flips from rules that only moved: equal-specificity ties, for review. */
  moveFlips: Flip[];
}

const PREFIX_RE = /^[a-z]+--/;
const ROOT_SPLIT_RE = /__|--/;

const defaultComponentOf = (cls: string) =>
  cls.replace(PREFIX_RE, "").split(ROOT_SPLIT_RE)[0];

/** Indexes of one longest strictly increasing subsequence (patience sorting). */
function longestIncreasing(values: number[]): Set<number> {
  const tails: number[] = [];
  const tailIdx: number[] = [];
  const prev: number[] = new Array(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < values[i]) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = values[i];
    tailIdx[lo] = i;
    prev[i] = lo > 0 ? tailIdx[lo - 1] : -1;
  }
  const out = new Set<number>();
  for (
    let i = tailIdx[tails.length - 1];
    i !== undefined && i >= 0;
    i = prev[i]
  )
    out.add(i);
  return out;
}

export interface DiffOptions {
  /**
   * The component a class belongs to: a rule that only moved is compared
   * with its own component's rules. Default: `bx--slider__thumb--lower` -> `slider`.
   */
  componentOf?: (className: string) => string;
}

/** What changed between two builds' rules, and which winners flipped. */
export function cascadeDiff(
  base: Rule[],
  head: Rule[],
  options: DiffOptions = {},
): CascadeDiff {
  return diffWith(DEFAULT_LIB, base, head, options.componentOf);
}

/** `cascadeDiff` over another implementation of the relations. */
export function diffWith(
  lib: CascadeLib,
  base: Rule[],
  head: Rule[],
  componentOf: (cls: string) => string = defaultComponentOf,
): CascadeDiff {
  const {
    candidates,
    coMatchable,
    conflictingProps,
    indexBySubject,
    matchContextMoves,
    wins,
  } = lib;

  // Multiset delta by key.
  const byKey = (rules: Rule[]) => {
    const m = new Map<string, Rule[]>();
    for (const r of rules) pushTo(m, r.key, r);
    return m;
  };
  const baseByKey = byKey(base);
  const headByKey = byKey(head);
  const removed: Rule[] = [];
  const added: Rule[] = [];
  for (const [key, list] of baseByKey)
    removed.push(...list.slice(headByKey.get(key)?.length ?? 0));
  for (const [key, list] of headByKey)
    added.push(...list.slice(baseByKey.get(key)?.length ?? 0));

  // Rewrites: same declarations and placement, new selector, a class (or a
  // subject attribute) in common. Rules from another `lib` may lack `attrs`.
  const related = ({ subject: x }: Rule, { subject: y }: Rule): boolean =>
    intersects(x.allClasses, y.allClasses) ||
    (Boolean(x.attrs && y.attrs) && intersects(x.attrs.keys(), y.attrs));
  const dropped = [...removed];
  const newRules = [...added];
  const rewrites = pairOff(
    dropped,
    newRules,
    (r, a) =>
      r.declBlock === a.declBlock && samePlacement(r, a) && related(r, a),
  );
  const contextMoves = matchContextMoves(dropped, newRules);

  // Base rule <-> head rule: equal keys pair up in order, rewrites and
  // context moves explicitly.
  const baseToHead = new Map<Rule, Rule>();
  for (const [key, hlist] of headByKey) {
    const blist = baseByKey.get(key) ?? [];
    for (let i = 0; i < Math.min(hlist.length, blist.length); i++)
      baseToHead.set(blist[i], hlist[i]);
  }
  for (const [h, b] of rewrites) baseToHead.set(b, h);
  for (const [h, b] of contextMoves) baseToHead.set(b, h);
  const headToBase = new Map<Rule, Rule>();
  for (const [b, h] of baseToHead) headToBase.set(h, b);

  // Moved rules: paired rules outside the longest run that kept its order,
  // so only the rules that jumped count, not everything after them.
  const movedHead = new Set<Rule>();
  {
    const position = new Map(head.map((r, i) => [r, i]));
    const pairedHead: Rule[] = [];
    for (const b of base) {
      const h = baseToHead.get(b);
      if (h) pairedHead.push(h);
    }
    const stable = longestIncreasing(
      pairedHead.map((h) => position.get(h) as number),
    );
    for (let i = 0; i < pairedHead.length; i++)
      if (!stable.has(i)) movedHead.add(pairedHead[i]);
  }

  const components = new Map<Rule, Set<string>>();
  const componentsOf = (r: Rule) => {
    let set = components.get(r);
    if (!set) {
      set = new Set([...r.subject.allClasses].map(componentOf));
      components.set(r, set);
    }
    return set;
  };
  const sameComponent = (a: Rule, b: Rule): boolean =>
    intersects(componentsOf(b), componentsOf(a));

  const headIndex = indexBySubject(head);
  const flips: Flip[] = [];
  const moveFlips: Flip[] = [];
  // New rules have no base to flip from.
  const changed = new Set<Rule>([
    ...rewrites.keys(),
    ...movedHead,
    ...contextMoves.keys(),
  ]);
  for (const rule of changed) {
    const ruleBase = headToBase.get(rule);
    if (!ruleBase) continue;
    const moveOnly =
      (movedHead.has(rule) || contextMoves.has(rule)) && !rewrites.has(rule);
    for (const other of candidates(rule, headIndex)) {
      const otherBase = headToBase.get(other);
      if (!otherBase || (moveOnly && !sameComponent(rule, other))) continue;
      if (!coMatchable(rule, other)) continue;
      for (const prop of conflictingProps(rule, other)) {
        const after = wins(rule, other, prop) ? "wins" : "loses";
        const before = wins(ruleBase, otherBase, prop) ? "wins" : "loses";
        if (before !== after)
          (moveOnly ? moveFlips : flips).push({
            rule,
            other,
            otherBase,
            prop,
            before,
            after,
          });
      }
    }
  }

  return {
    removed,
    added,
    rewrites,
    newRules,
    dropped,
    contextMoves,
    movedHead,
    flips,
    moveFlips,
  };
}
