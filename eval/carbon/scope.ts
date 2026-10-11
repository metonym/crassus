/**
 * Impact scoping: `compareCss` reading only what each change can reach,
 * against reading everything, on 25 segments of perf/refactor/chore(css)
 * commits (2d710c03e..97164eeec) and the golden cases, over today's fixtures: results must be
 * identical, and both are timed. One theme, one viewport, one run at a time,
 * each started once the 1-minute load is below the core count.
 *
 *   CCS_ROOT=… bun eval/carbon/scope.ts [--cases golden|segments|all] [--only <case>] [--concurrency 4]
 */
import path from "node:path";
import { compareCss, type Impact } from "../../src/browser/compare";
import { pageIndex } from "../../src/browser/page-index";
import {
  cssAt,
  fixtureOpts,
  GOLDEN,
  ONE_RULE,
  quiet,
  type Run,
  segments,
} from "./cases";
import { loadAvg, opt, results } from "./ccs";

const CASES = opt("cases") ?? "all";
const ONLY = opt("only");
const NON_WORD_RE = /\W+/g;
const OUT = results("scope");

const normalized = (r: Run) =>
  JSON.stringify({
    pages: r.pages.map(({ file, changed, removed, added, uncompared }) => ({
      file,
      changed,
      removed,
      added,
      uncompared,
    })),
    groups: r.groups,
    uncompared: r.uncompared,
    notReady: [...r.notReady].sort(),
    files: r.files,
  });

const shared = await fixtureOpts();
const cases = [
  ...(CASES === "segments" || CASES === "golden" ? [] : ONE_RULE),
  ...(CASES === "segments" ? [] : GOLDEN),
  ...(CASES === "golden" ? [] : await segments()),
].filter((c) => !ONLY || c.name.includes(ONLY));

console.log(
  `${cases.length} case(s) on ${shared.fixtures.length} fixtures (white, 1280x900, states), ${shared.concurrency} tabs`,
);
{
  // The page index, built once (its own directory, so it's never stale).
  await quiet();
  const built = await pageIndex({
    ...shared,
    cacheDir: path.join(OUT, `index-${Date.now()}`),
  });
  console.log(
    `page index built in ${(built.ms / 1000).toFixed(1)} s (load ${loadAvg()})`,
  );
}
const rows: {
  name: string;
  full: number;
  scoped: number;
  impact: Impact;
  identical: boolean;
  visible: number;
  problem: string | null;
}[] = [];
for (const c of cases) {
  // biome-ignore lint/performance/noAwaitInLoops: one run at a time
  const built = await Promise.all([cssAt(c.base), cssAt(c.head)]).catch(
    (e: Error) => e,
  );
  if (built instanceof Error) {
    console.log(
      `${c.name.padEnd(44)} skipped: ${built.message.split("\n")[0]}`,
    );
    continue;
  }
  const [base, ref] = built;
  const head = c.edit ? ref.replaceAll(c.edit[0], c.edit[1]) : ref;
  if (head === ref && c.edit)
    throw new Error(`${c.name}: the edit doesn't apply`);
  const opts = { ...shared, base, head, states: "cdp" as const };
  await quiet();
  const full = await compareCss({ ...opts, scope: false });
  await quiet();
  const scoped = await compareCss(opts);
  const identical = normalized(full) === normalized(scoped);
  if (!identical)
    await Bun.write(
      path.join(OUT, `${c.name.replace(NON_WORD_RE, "-")}.json`),
      JSON.stringify(
        {
          full: JSON.parse(normalized(full)),
          scoped: JSON.parse(normalized(scoped)),
        },
        null,
        1,
      ),
    );
  const row = {
    name: c.name,
    full: full.ms,
    scoped: scoped.ms,
    impact: scoped.impact,
    identical,
    visible: scoped.groups
      .filter((g) => !g.invisible)
      .reduce((n, g) => n + g.count, 0),
    problem: c.expect?.(scoped) ?? null,
  };
  rows.push(row);
  console.log(
    `${c.name.padEnd(44)} full ${(row.full / 1000).toFixed(1).padStart(6)} s  scoped ${(row.scoped / 1000).toFixed(1).padStart(6)} s  ${row.impact.everything ? `everything: ${row.impact.everything}` : `${row.impact.pages}/${row.impact.total} pages, ${row.impact.elements} elements`}  ${row.visible} visible  ${identical ? "identical" : "DIFFERENT"}${row.problem ? `  ${row.problem}` : ""}  (load ${loadAvg()})`,
  );
}
const sum = (k: "full" | "scoped") => rows.reduce((n, r) => n + r[k], 0) / 1000;
console.log(
  `\n${rows.length} case(s): full ${sum("full").toFixed(1)} s, scoped ${sum("scoped").toFixed(1)} s (${(sum("full") / sum("scoped")).toFixed(1)}x); ${rows.filter((r) => !r.identical).length} different, ${rows.filter((r) => r.problem).length} failed checks`,
);
await Bun.write(path.join(OUT, "results.json"), JSON.stringify(rows, null, 2));
process.exit(rows.every((r) => r.identical && !r.problem) ? 0 : 1);
