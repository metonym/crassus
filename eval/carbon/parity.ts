/**
 * Parity + perf: carbon-components-svelte's css-tree-based scripts/lib vs
 * the crassus core, on sass-expanded css/{all,white}.scss (what its CLIs
 * feed the libs), the minified css/all.css build, and bench/corpora.ts.
 *
 *   CCS_ROOT=… bun eval/carbon/parity.ts [--runs 7]
 */
import path from "node:path";
import { CORPORA } from "../../bench/corpora";
import type { Rule } from "../../src/core/cascade";
// biome-ignore lint/performance/noNamespaceImport: comparing two libraries with identical export names
import * as newCascade from "../../src/core/cascade";
// biome-ignore lint/performance/noNamespaceImport: comparing two libraries with identical export names
import * as newOverrides from "../../src/core/overrides";
import {
  CCS_ROOT,
  loadOldCascade,
  loadOldOverrides,
  opt,
  results,
  strip,
  withSass,
} from "./ccs";

const oldCascade = await loadOldCascade();
const oldOverrides = await loadOldOverrides();

const RUNS = Number(opt("runs") || 7);

async function inputs(): Promise<{ name: string; css: string }[]> {
  const cssDir = path.join(CCS_ROOT, "css");
  const out = await withSass(async (compile) => {
    const compiled: { name: string; css: string }[] = [];
    for (const entry of ["all", "white"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one compiler, in order
      const { css } = await compile(cssDir, entry, { style: "expanded" });
      compiled.push({ name: `${entry}.scss (expanded)`, css });
    }
    return compiled;
  });
  out.push(
    {
      name: "all.css (minified build)",
      css: await Bun.file(path.join(cssDir, "all.css")).text(),
    },
    ...CORPORA,
  );
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function time(fn: () => unknown): number {
  fn(); // warm
  const xs: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = Bun.nanoseconds();
    fn();
    xs.push((Bun.nanoseconds() - t) / 1e6);
  }
  return median(xs);
}

class Tally {
  counts = new Map<string, number>();
  examples = new Map<string, string[]>();
  add(cat: string, ex: string) {
    this.counts.set(cat, (this.counts.get(cat) ?? 0) + 1);
    const list = this.examples.get(cat) ?? [];
    if (list.length < 3) list.push(ex);
    this.examples.set(cat, list);
  }
}

const setEq = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));

function compareRules(a: Rule[], b: Rule[], tally: Tally): void {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const o = a[i];
    const x = b[i];
    const where = x.selector.slice(0, 80);
    if (strip(o.selector) !== strip(x.selector))
      tally.add(
        "selector",
        `${o.selector.slice(0, 70)}  vs  ${x.selector.slice(0, 70)}`,
      );
    if (strip(o.context) !== strip(x.context))
      tally.add("context", `${o.context}  vs  ${x.context}`);
    if (o.order !== x.order) tally.add("order", where);
    if (o.specificity.join() !== x.specificity.join())
      tally.add(
        "specificity",
        `${where} old=${o.specificity} new=${x.specificity}`,
      );
    const so = o.subject;
    const sx = x.subject;
    if (
      !setEq(so.classes, sx.classes) ||
      !setEq(so.negated, sx.negated) ||
      !setEq(so.allClasses, sx.allClasses) ||
      !setEq(so.allNegated, sx.allNegated) ||
      so.type !== sx.type ||
      so.qualified !== sx.qualified
    )
      tally.add("subject", where);
    if (so.pseudoElement !== sx.pseudoElement)
      tally.add(
        "subject.pseudoElement",
        `${where} old=${so.pseudoElement} new=${sx.pseudoElement}`,
      );
    if (strip(o.declBlock) !== strip(x.declBlock)) {
      const od = [...o.decls];
      const nd = [...x.decls];
      const k = od.findIndex(
        ([p, v], j) => p !== nd[j]?.[0] || strip(v) !== strip(nd[j]?.[1] ?? ""),
      );
      tally.add(
        "declBlock",
        `${where} :: ${JSON.stringify(od[k])} vs ${JSON.stringify(nd[k])}`,
      );
    }
    if (
      o.loc &&
      x.loc &&
      (o.loc.line !== x.loc.line || o.loc.column !== x.loc.column)
    )
      tally.add(
        "loc",
        `${where} old=${o.loc.line}:${o.loc.column} new=${x.loc.line}:${x.loc.column}`,
      );
  }
  if (a.length !== b.length)
    tally.add("count", `old=${a.length} new=${b.length}`);
}

const deadKey = (d: { context: string; selector: string; property: string }) =>
  `${strip(d.context)}|${strip(d.selector)}|${d.property}`;

const summary: unknown[] = [];
for (const { name, css } of await inputs()) {
  const tally = new Tally();
  const newRules = newCascade.parseRules(css, true);
  let oldError: string | undefined;
  try {
    compareRules(oldCascade.parseRules(css, true), newRules, tally);
  } catch (e) {
    oldError = (e as Error).message;
  }

  const oldDead = new Set(oldOverrides.deadDeclarations(css).map(deadKey));
  const newDead = new Set(newOverrides.deadDeclarations(css).map(deadKey));
  const onlyOld = [...oldDead].filter((k) => !newDead.has(k));
  const onlyNew = [...newDead].filter((k) => !oldDead.has(k));

  const t = {
    oldParse: time(() => oldCascade.parseRules(css)),
    newParse: time(() => newCascade.parseRules(css)),
    oldParsePos: time(() => oldCascade.parseRules(css, true)),
    newParsePos: time(() => newCascade.parseRules(css, true)),
    oldDead: time(() => oldOverrides.deadDeclarations(css)),
    newDead: time(() => newOverrides.deadDeclarations(css)),
  };

  const mismatched = [...tally.counts.values()].reduce((a, b) => a + b, 0);
  console.log(
    `\n## ${name}  (${(css.length / 1024).toFixed(0)} kB, ${newRules.length} selector-rules${oldError ? `, css-tree threw: ${oldError}` : ""})`,
  );
  console.log(
    `parseRules: ${t.oldParse.toFixed(1)} → ${t.newParse.toFixed(1)} ms (${(t.oldParse / t.newParse).toFixed(1)}×)` +
      `   +positions: ${t.oldParsePos.toFixed(1)} → ${t.newParsePos.toFixed(1)} ms (${(t.oldParsePos / t.newParsePos).toFixed(1)}×)` +
      `   deadDeclarations: ${t.oldDead.toFixed(1)} → ${t.newDead.toFixed(1)} ms (${(t.oldDead / t.newDead).toFixed(1)}×)`,
  );
  console.log(
    `rule fields: ${mismatched === 0 ? "identical" : `${mismatched} mismatches`}` +
      `   dead decls: old ${oldDead.size} / new ${newDead.size} (only old ${onlyOld.length}, only new ${onlyNew.length})`,
  );
  for (const [cat, count] of tally.counts) {
    console.log(`  ${cat}: ${count}`);
    for (const ex of tally.examples.get(cat) ?? [])
      console.log(`    e.g. ${ex}`);
  }
  for (const k of onlyOld.slice(0, 3)) console.log(`  dead only old: ${k}`);
  for (const k of onlyNew.slice(0, 3)) console.log(`  dead only new: ${k}`);
  summary.push({
    name,
    bytes: css.length,
    rules: newRules.length,
    timings: t,
    mismatches: Object.fromEntries(tally.counts),
    dead: {
      old: oldDead.size,
      new: newDead.size,
      onlyOld: onlyOld.length,
      onlyNew: onlyNew.length,
    },
  });
}
await Bun.write(results("parity.json"), JSON.stringify(summary, null, 2));
