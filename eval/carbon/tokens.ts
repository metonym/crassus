/**
 * Token tracing on the eval's stylesheet changes, with `--visual` off (white,
 * 1280x900, forced states): the TooltipDefinition regression must come out
 * as a token-detached card (`color` stops following `--cds-text-01`), and
 * the cost of tracing is timed against the same compare without it.
 *
 *   CCS_ROOT=… bun eval/carbon/tokens.ts [--concurrency 4]
 */
import { compareCss } from "../../src/browser/compare";
import { buildCards } from "../../src/core/cards";
import { cssAt, fixtureOpts, GOLDEN, quiet } from "./cases";
import { loadAvg } from "./ccs";

const TRIGGER = ".bx--tooltip--definition .bx--tooltip__trigger";

const shared = await fixtureOpts();
let failed = 0;
for (const c of GOLDEN.slice(0, 3)) {
  // biome-ignore lint/performance/noAwaitInLoops: one run at a time
  const [base, head] = await Promise.all([cssAt(c.base), cssAt(c.head)]);
  const opts = {
    ...shared,
    base,
    head,
    states: "cdp" as const,
    explain: true,
  };
  await quiet();
  const plain = await compareCss(opts);
  await quiet();
  const traced = await compareCss({ ...opts, tokens: "--cds-" });
  const cards = buildCards([{ pages: traced.pages }]);
  const detached = cards.filter((x) => x.verdict === "token-detached");
  const trigger = detached.find(
    (x) =>
      x.cause.rule?.selector === TRIGGER &&
      x.tokens?.from.includes("--cds-text-01"),
  );
  const problem =
    c.name.startsWith("regression") && !trigger
      ? "the trigger's color isn't a token-detached card"
      : null;
  if (problem) failed++;
  console.log(
    `${c.name.padEnd(42)} plain ${(plain.ms / 1000).toFixed(1).padStart(5)} s  traced ${(traced.ms / 1000).toFixed(1).padStart(5)} s  ${detached.length} token-detached card(s)  ${problem ? `FAIL: ${problem}` : "ok"}  (load ${loadAvg()})`,
  );
  for (const card of detached)
    console.log(
      `    ${card.id}  ${card.title}  [${card.elements.length}; from ${card.tokens?.from.join(", ")}]`,
    );
}
process.exit(failed ? 1 : 0);
