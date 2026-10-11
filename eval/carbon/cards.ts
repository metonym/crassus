/**
 * Change cards on three known changes, over today's
 * fixtures (white, 1280x900, forced states, explain and visual):
 *
 * - the TooltipDefinition regression (28e700f30..7e301af6f) is one visible
 *   card: `.bx--tooltip--definition .bx--tooltip__trigger` no longer sets
 *   color, #161616 -> #000, with a ΔE;
 * - #3839 (660b2936a): the nested child-row cells' changes are one card;
 * - the flattening (ee361d560^..d5e117c9c): visible cards only on the
 *   consumer-override fixture, none on a disabled icon button's :focus.
 *
 *   CCS_ROOT=… bun eval/carbon/cards.ts [--concurrency 4]
 */
import { compareCss } from "../../src/browser/compare";
import { buildCards, type Card } from "../../src/core/cards";
import { type Case, cssAt, fixtureOpts, GOLDEN, quiet } from "./cases";
import { loadAvg } from "./ccs";

const TRIGGER = ".bx--tooltip--definition .bx--tooltip__trigger";
const NESTED_CELL_RE = /child-row-inner-container.*>td(\[\d+\])?$/;
const DISABLED_FOCUS_RE = /disabled.*@focus/;

const CASES: (Case & { check: (cards: Card[]) => string | null })[] = [
  {
    ...GOLDEN[0],
    check(cards) {
      const hits = cards.filter((c) =>
        c.changes.some(
          (x) =>
            x.property === "color" &&
            x.before === "rgb(22, 22, 22)" &&
            x.after === "rgb(0, 0, 0)",
        ),
      );
      const visible = hits.filter((c) => c.verdict === "visible");
      if (visible.length !== 1)
        return `${visible.length} visible cards carry the trigger color`;
      const [card] = visible;
      if (card.cause.kind !== "lost" || card.cause.rule?.selector !== TRIGGER)
        return `the card blames ${card.cause.rule?.selector ?? card.cause.kind}`;
      return card.deltaE ? null : "no ΔE";
    },
  },
  {
    ...GOLDEN[1],
    check(cards) {
      const nested = cards.filter(
        (c) =>
          c.verdict === "visible" &&
          c.elements.some((e) => NESTED_CELL_RE.test(e.path)),
      );
      return nested.length === 1
        ? null
        : `the nested cells' changes are on ${nested.length} cards`;
    },
  },
  {
    ...GOLDEN[2],
    check(cards) {
      const visible = cards.filter((c) => c.verdict === "visible");
      const elsewhere = visible.filter((c) =>
        c.pages.some((p) => !p.startsWith("consumer-override")),
      );
      if (elsewhere.length)
        return `visible cards off consumer-override: ${elsewhere.map((c) => c.pages.join()).join("; ")}`;
      return visible.some((c) =>
        c.elements.some((e) => DISABLED_FOCUS_RE.test(e.path)),
      )
        ? "a disabled icon button's :focus shows"
        : null;
    },
  },
];

const shared = await fixtureOpts();
let failed = 0;
for (const c of CASES) {
  // biome-ignore lint/performance/noAwaitInLoops: one run at a time
  const [base, head] = await Promise.all([cssAt(c.base), cssAt(c.head)]);
  await quiet();
  const r = await compareCss({
    ...shared,
    base,
    head,
    states: "cdp",
    explain: true,
    visual: true,
    report: true,
  });
  const cards = buildCards([{ pages: r.pages }]);
  const problem = c.check(cards);
  if (problem) failed++;
  const count = (v: string) => cards.filter((x) => x.verdict === v).length;
  console.log(
    `${c.name.padEnd(42)} ${(r.ms / 1000).toFixed(1).padStart(5)} s  ${count("visible")} visible, ${count("imperceptible")} imperceptible, ${count("invisible")} invisible card(s)  ${problem ? `FAIL: ${problem}` : "ok"}  (load ${loadAvg()})`,
  );
  for (const card of cards.filter((x) => x.verdict === "visible"))
    console.log(`    ${card.id}  ${card.title}  [${card.elements.length}]`);
}
process.exit(failed ? 1 : 0);
