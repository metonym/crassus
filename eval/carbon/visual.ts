/**
 * `compare --visual`: what it costs over a plain compare, and what it
 * concludes, on stylesheet changes over today's fixtures (white, 1280x900,
 * forced states): elements whose pixels differ, how far (CIEDE2000), and the
 * changes marked invisible, by reason. Checks known cases: the
 * TooltipDefinition trigger color is visible with a ΔE, and seg 0's
 * clipped `.bx--assistive-text` moves are invisible.
 *
 *   CCS_ROOT=… bun eval/carbon/visual.ts [--only <case>] [--concurrency 4] [--out <name>]
 */
import path from "node:path";
import { compareCss } from "../../src/browser/compare";
import {
  type Case,
  cssAt,
  fixtureOpts,
  GOLDEN,
  quiet,
  type Run,
  segments,
} from "./cases";
import { loadAvg, opt, results } from "./ccs";

const ONLY = opt("only");
const OUT = results("visual");

const TRIGGER_RE = /tooltip__trigger--definition/;
const ASSISTIVE_RE = /bx--assistive-text$/;
const POSITION = new Set(["top", "right", "bottom", "left", "inset"]);

const triggerColor = (r: Run) =>
  r.groups.find(
    (g) =>
      g.property === "color" &&
      !g.invisible &&
      g.examples.some((e) => TRIGGER_RE.test(e.path)),
  );

const CASES: Case[] = [
  {
    ...GOLDEN[0],
    expect(r) {
      const g = triggerColor(r);
      if (!g) return "no visible trigger color change";
      return g.deltaE ? null : "no ΔE on the trigger color change";
    },
  },
  {
    ...(await segments())[0],
    expect(r) {
      const visible = r.groups.filter(
        (g) =>
          !g.invisible &&
          POSITION.has(g.property) &&
          g.examples.some((e) => ASSISTIVE_RE.test(e.path)),
      );
      return visible.length
        ? `${visible.reduce((n, g) => n + g.count, 0)} .bx--assistive-text position change(s) still visible`
        : null;
    },
  },
  GOLDEN[1],
  {
    name: "recolor #0f62fe",
    base: "HEAD",
    head: "HEAD",
    edit: ["#0f62fe", "#0e61fd"],
  },
];

const shared = await fixtureOpts();
console.log(
  `${shared.fixtures.length} fixtures (white, 1280x900, states), ${shared.concurrency} tabs`,
);
const rows: object[] = [];
for (const c of CASES.filter((c) => !ONLY || c.name.includes(ONLY))) {
  // biome-ignore lint/performance/noAwaitInLoops: one run at a time
  const [base, ref] = await Promise.all([cssAt(c.base), cssAt(c.head)]);
  const head = c.edit ? ref.replaceAll(c.edit[0], c.edit[1]) : ref;
  const opts = { ...shared, base, head, states: "cdp" as const };
  await quiet();
  const plain = await compareCss(opts);
  await quiet();
  const visual = await compareCss({ ...opts, visual: true });
  const pixels = visual.pages.flatMap((p) => Object.values(p.pixels ?? {}));
  const reasons: Record<string, number> = {};
  for (const g of visual.groups)
    if (g.invisible)
      reasons[g.invisible] = (reasons[g.invisible] ?? 0) + g.count;
  const imperceptible = visual.pages
    .flatMap((p) => Object.values(p.deltaE ?? {}))
    .filter((d) => d.max < 1).length;
  const trigger = triggerColor(visual)?.deltaE;
  const row = {
    name: c.name,
    plain: plain.ms,
    visual: visual.ms,
    changed: pixels.length,
    differ: pixels.filter(Boolean).length,
    imperceptible,
    invisible: reasons,
    trigger,
    problem: c.expect?.(visual) ?? null,
  };
  rows.push(row);
  console.log(
    `${c.name.padEnd(36)} plain ${(row.plain / 1000).toFixed(1).padStart(6)} s  visual ${(row.visual / 1000).toFixed(1).padStart(6)} s  pixels differ ${row.differ}/${row.changed}  imperceptible ${imperceptible}${trigger ? `  trigger ΔE max ${trigger.max.toFixed(2)} mean ${trigger.mean.toFixed(2)}` : ""}  invisible ${JSON.stringify(reasons)}${row.problem ? `  FAIL: ${row.problem}` : ""}  (load ${loadAvg()})`,
  );
}
await Bun.write(
  path.join(OUT, `${opt("out") ?? "results"}.json`),
  JSON.stringify(rows, null, 2),
);
