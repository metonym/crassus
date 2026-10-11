/**
 * `crassus coverage` on today's fixtures (white, 1280x900), cross-checked
 * against `crassus usage` (which records whether each declaration matched
 * and won): a covered declaration should have won somewhere, an unmatched
 * one should never have matched, and one that decides nothing should
 * mostly have lost, or won with the value that wins without it.
 *
 *   CCS_ROOT=… bun eval/carbon/coverage.ts (after `crassus coverage --json`
 *   and `crassus usage` in CCS_ROOT, into .eval/coverage.json and .eval/usage)
 */
import path from "node:path";
import { parseSelectorList, serialize } from "../../src/core/selector";
import { opt, results } from "./ccs";

const coverage = await Bun.file(
  opt("coverage") ?? results("coverage.json"),
).json();
const usage = await Bun.file(
  path.join(opt("usage") ?? results("usage"), "usage.json"),
).json();

const counts = new Map<string, { matched: number; won: number }>();
for (const d of usage.declarations) {
  const key = `${d.selector}\0${d.property}`;
  const c = counts.get(key) ?? { matched: 0, won: 0 };
  c.matched += d.matched;
  c.won += d.won;
  counts.set(key, c);
}
const table: Record<string, Record<string, number>> = {};
for (const d of coverage.declarations) {
  let selectors: string[] = [];
  try {
    selectors = parseSelectorList(d.selector).map(serialize);
  } catch {}
  let seen = false;
  let matched = 0;
  let won = 0;
  for (const s of selectors) {
    const c = counts.get(`${s}\0${d.property.toLowerCase()}`);
    if (!c) continue;
    seen = true;
    matched += c.matched;
    won += c.won;
  }
  // Usage keys by selector and property across contexts, so a selector
  // repeated in a breakpoint's @media reads as the plain one's.
  const said = !seen
    ? "not in usage"
    : matched === 0
      ? "never matched"
      : won === 0
        ? "matched, never won"
        : "won";
  table[d.status] ??= {};
  table[d.status][said] = (table[d.status][said] ?? 0) + 1;
}
const { summary } = coverage;
console.log(
  `coverage: ${summary.covered} of ${summary.declarations} declarations (${((100 * summary.covered) / summary.declarations).toFixed(1)}%), ${summary.unmatched} unmatched, ${summary.decidesNothing} deciding nothing, ${summary.conditionNeverHolds} under a condition that never held, in ${(coverage.ms / 1000).toFixed(1)} s`,
);
for (const [status, row] of Object.entries(table))
  console.log(`  ${status.padEnd(16)} usage: ${JSON.stringify(row)}`);
