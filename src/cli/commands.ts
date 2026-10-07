import {
  type Histogram,
  histogram,
  histogramByFile,
  parseRules,
  type Rule,
} from "../core/cascade";
import type { Config } from "../core/config";
import { cascadeDiff, type Flip } from "../core/diff";
import { type DeadDeclaration, deadDeclarations } from "../core/overrides";
import type { Specificity } from "../core/selector";
import { bytesOf } from "../core/usage";
import { type Size, sizeOf } from "./size";
import {
  type Locate,
  locateIn,
  type Sheet,
  type SourceLocation,
} from "./sources";

export interface DeadFinding extends DeadDeclaration {
  source?: SourceLocation;
}

export interface DeadResult {
  entry: string;
  dead: DeadFinding[];
  /** Bytes the dead declarations take (`property: value`). */
  bytes: number;
}

export function runDead(sheets: Sheet[]): DeadResult[] {
  return sheets.map((sheet) => {
    const locate = locateIn(sheet);
    const dead = deadDeclarations(sheet.css, true).map((d) => {
      const source = locate(d.loc);
      return source ? { ...d, source } : d;
    });
    return {
      entry: sheet.name,
      dead,
      bytes: dead.reduce((n, d) => n + bytesOf(d), 0),
    };
  });
}

export interface RuleRef {
  selector: string;
  context: string;
  layer: string;
  scope: string;
  specificity: Specificity;
  declarations: string;
  source?: SourceLocation;
}

export interface FlipFinding {
  rule: RuleRef;
  other: RuleRef;
  /** The other rule's selector in the base, when it changed. */
  otherWas?: string;
  property: string;
  before: "wins" | "loses";
  after: "wins" | "loses";
}

export interface DiffResult {
  entry: string;
  counts: {
    removed: number;
    added: number;
    rewrites: number;
    newRules: number;
    droppedRules: number;
    movedRules: number;
    contextMoves: number;
  };
  histogram: { base: Histogram; head: Histogram };
  /** Top files by selectors at three or more classes. */
  files: { file: string; base: number; head: number }[];
  size: { base: Size; head: Size };
  dropped: RuleRef[];
  newRules: RuleRef[];
  rewrites: { from: RuleRef; to: RuleRef }[];
  contextMoves: { from: RuleRef; to: RuleRef }[];
  /** Winner changed against a co-matchable rule: fails the run. */
  flips: FlipFinding[];
  /** Equal-specificity ties a moved rule now wins or loses: review only. */
  moveFlips: FlipFinding[];
}

const refOf = (rule: Rule, locate: Locate): RuleRef => {
  const ref: RuleRef = {
    selector: rule.selector,
    context: rule.context,
    layer: rule.layer,
    scope: rule.scope,
    specificity: rule.specificity,
    declarations: rule.declBlock,
  };
  const source = locate(rule.loc);
  if (source) ref.source = source;
  return ref;
};

const weight = (h: Histogram | undefined) =>
  h ? h.classes[3] + h.classes[4] : 0;

export async function runDiff(
  base: Sheet[],
  head: Sheet[],
  config: Config,
): Promise<{ results: DiffResult[]; onlyBase: string[]; onlyHead: string[] }> {
  const results: DiffResult[] = [];
  for (const h of head) {
    const b = base.find((s) => s.name === h.name);
    if (!b) continue;
    const baseRules = parseRules(b.css, true);
    const headRules = parseRules(h.css, true);
    const d = cascadeDiff(baseRules, headRules, {
      componentOf: config.componentOf,
    });
    const locateBase = locateIn(b);
    const locateHead = locateIn(h);
    // One ref per rule, so reports can group findings by rule.
    const refs = new Map<Rule, RuleRef>();
    const refAt = (locate: Locate) => (r: Rule) => {
      let ref = refs.get(r);
      if (!ref) {
        ref = refOf(r, locate);
        refs.set(r, ref);
      }
      return ref;
    };
    const atBase = refAt(locateBase);
    const atHead = refAt(locateHead);
    const moved = ([to, from]: [Rule, Rule]) => ({
      from: atBase(from),
      to: atHead(to),
    });
    const flip = (f: Flip): FlipFinding => {
      const out: FlipFinding = {
        rule: atHead(f.rule),
        other: atHead(f.other),
        property: f.prop,
        before: f.before,
        after: f.after,
      };
      if (f.otherBase && f.otherBase.selector !== f.other.selector)
        out.otherWas = f.otherBase.selector;
      return out;
    };
    const fileOf = (locate: Locate) => (r: Rule) => locate(r.loc)?.file;
    const filesBase = histogramByFile(baseRules, fileOf(locateBase));
    const filesHead = histogramByFile(headRules, fileOf(locateHead));
    const files = [...new Set([...filesBase.keys(), ...filesHead.keys()])]
      .map((file) => ({
        file,
        base: weight(filesBase.get(file)),
        head: weight(filesHead.get(file)),
      }))
      .sort((x, y) => y.head - x.head || y.base - x.base)
      .slice(0, 10);
    // biome-ignore lint/performance/noAwaitInLoops: one entry at a time keeps memory flat
    const [sizeBase, sizeHead] = await Promise.all([
      sizeOf(b.css),
      sizeOf(h.css),
    ]);
    results.push({
      entry: h.name,
      counts: {
        removed: d.removed.length,
        added: d.added.length,
        rewrites: d.rewrites.size,
        newRules: d.newRules.length,
        droppedRules: d.dropped.length,
        movedRules: d.movedHead.size,
        contextMoves: d.contextMoves.size,
      },
      histogram: { base: histogram(baseRules), head: histogram(headRules) },
      files,
      size: { base: sizeBase, head: sizeHead },
      dropped: d.dropped.map(atBase),
      newRules: d.newRules.map(atHead),
      rewrites: [...d.rewrites].map(moved),
      contextMoves: [...d.contextMoves].map(moved),
      flips: d.flips.map(flip),
      moveFlips: d.moveFlips.map(flip),
    });
  }
  const only = (these: Sheet[], those: Sheet[]) =>
    these
      .filter((t) => !those.some((s) => s.name === t.name))
      .map((t) => t.name);
  return { results, onlyBase: only(base, head), onlyHead: only(head, base) };
}
