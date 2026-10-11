/**
 * `diff --confirm` on the refactor segments: each rung-1 cascade flip
 * rendered in Chrome (white, 1280x900) on a fixture page with an element
 * both rules match, or on one built for it, or dropped when no fixture
 * element carries the pair. Segs 5 and 14 must lose most of their flips;
 * flips confirmed on a fixture page are checked against `compare` there
 * (confirming forces states on every element a rule names, even where
 * no user can reach them, which `compare` skips).
 *
 *   CCS_ROOT=… bun eval/carbon/flips.ts [--only "seg 5"]
 */
import { compareCss } from "../../src/browser/compare";
import { confirmFlips } from "../../src/browser/flips";
import { pageIndex } from "../../src/browser/page-index";
import { parseRules } from "../../src/core/cascade";
import { cascadeDiff } from "../../src/core/diff";
import { cssAt, fixtureOpts, quiet, segments } from "./cases";
import { opt } from "./ccs";

const ONLY = opt("only");
const opts = await fixtureOpts(4);
await quiet();
const { index } = await pageIndex({ ...opts, cacheDir: opts.indexDir });
let failed = 0;
let total = 0;
const tally: Record<string, number> = {};
for (const c of await segments()) {
  if (ONLY && c.name !== ONLY) continue;
  // biome-ignore lint/performance/noAwaitInLoops: one segment at a time
  const [base, head] = await Promise.all([cssAt(c.base), cssAt(c.head)]);
  const d = cascadeDiff(parseRules(base), parseRules(head));
  const flips = [...d.flips, ...d.moveFlips];
  if (!flips.length) continue;
  const started = performance.now();
  const verdicts = await confirmFlips({
    flips: flips.map((f) => ({
      selectors: [f.rule.selector, f.other.selector],
      property: f.prop,
    })),
    base,
    head,
    index,
    engine: "chrome",
  });
  const ms = performance.now() - started;
  const counts: Record<string, number> = {};
  for (const v of verdicts) {
    counts[v.verdict] = (counts[v.verdict] ?? 0) + 1;
    tally[v.verdict] = (tally[v.verdict] ?? 0) + 1;
  }
  total += flips.length;
  const onFixture = flips.flatMap((f, i) => {
    const { verdict, on } = verdicts[i];
    return verdict === "confirmed" && on !== "synthesized"
      ? [{ prop: f.prop, on }]
      : [];
  });
  let unseen = 0;
  if (onFixture.length) {
    const r = await compareCss({
      ...opts,
      fixtures: [...new Set(onFixture.map((x) => x.on?.split(" ")[0] ?? ""))],
      base,
      head,
      states: "cdp",
    });
    for (const { prop, on } of onFixture) {
      const page = r.pages.find((p) => p.file === on?.replace(" ", "."));
      const seen = Object.values(page?.changed ?? {})
        .flat()
        .some((ch) =>
          [ch.property, ...(ch.aliases ?? [])].some((p) => p.startsWith(prop)),
        );
      if (!seen) unseen++;
    }
  }
  const dropped = (counts["never seen"] ?? 0) + (counts["no change"] ?? 0);
  const problem =
    (c.name === "seg 5" || c.name === "seg 14") && dropped * 2 <= flips.length
      ? "most flips should be dropped"
      : null;
  if (problem) failed++;
  const fixtureConfirmed = onFixture.length;
  console.log(
    `${c.name.padEnd(7)} ${String(flips.length).padStart(4)} flip(s) in ${(ms / 1000).toFixed(1)} s: ${JSON.stringify(counts)}${fixtureConfirmed ? `; ${fixtureConfirmed - unseen} of ${fixtureConfirmed} confirmed on a fixture also change in compare` : ""}${problem ? `  FAIL: ${problem}` : ""}`,
  );
}
console.log(`\n${total} flip(s): ${JSON.stringify(tally)}`);
process.exit(failed ? 1 : 0);
