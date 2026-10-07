/**
 * cascade-usage: Playwright driver (e2e/cascade-usage.ts) vs Bun.WebView
 * with the CDP matcher (same Chromium build) vs the in-page `dom` matcher
 * on Chrome and WebKit.
 *
 *   CCS_ROOT=… bun eval/carbon/usage.ts [--only button] [--skip-old] [--runs cdp,dom]
 */
import { loadavg } from "node:os";
import path from "node:path";
import { serveFixtures } from "../../src/browser/serve";
import {
  runUsage,
  type UsageFile,
  type UsageOptions,
} from "../../src/browser/usage";
import type { DeclarationStats, Summary } from "../../src/core/usage";
import {
  args,
  CCS_ROOT,
  fixtureNames,
  fixturesDir,
  loadAvg,
  oldTool,
  opt,
  PLAYWRIGHT_SHELL,
  results,
  strip,
} from "./ccs";

const OLD = args.includes("--skip-old")
  ? undefined
  : oldTool("e2e/cascade-usage.ts", "pass --skip-old");
const ONLY = opt("only");
const K = Number(opt("concurrency") ?? 8);
const RUNS = opt("runs")?.split(",");
const out = (n: string) => results("usage", n);

const fixtures = await fixtureNames(ONLY);
const themes = ["white", "g100"];
const server = serveFixtures(await fixturesDir());

const norm = (s: string) => strip(s).replace(/::/g, ":");
const ctxNorm = (c: string) => c.split(" / ").map(norm).sort().join("/");
const declKey = (d: DeclarationStats) =>
  `${ctxNorm(d.context)}|${norm(d.selector)}|${d.property}|${norm(d.value)}|${d.important}`;
const unmatchedKeys = (f: UsageFile) =>
  new Set(f.unmatched.map((r) => `${ctxNorm(r.context)}|${norm(r.selector)}`));

async function compare(aDir: string, bDir: string) {
  const a: UsageFile = await Bun.file(path.join(aDir, "usage.json")).json();
  const b: UsageFile = await Bun.file(path.join(bDir, "usage.json")).json();
  const ma = new Map(a.declarations.map((d) => [declKey(d), d]));
  const mb = new Map(b.declarations.map((d) => [declKey(d), d]));
  let same = 0;
  let matchedDiff = 0;
  let wonDiff = 0;
  let onlyA = 0;
  let onlyB = 0;
  let verdictDiff = 0;
  const ex: string[] = [];
  for (const [k, da] of ma) {
    const db = mb.get(k);
    if (!db) {
      onlyA++;
      if (ex.length < 6) ex.push(`only ${path.basename(aDir)}: ${k}`);
      continue;
    }
    if (da.matched === db.matched && da.won === db.won) same++;
    if (da.matched !== db.matched) matchedDiff++;
    if (da.won !== db.won) wonDiff++;
    if ((da.won === 0) !== (db.won === 0)) {
      verdictDiff++;
      if (ex.length < 6)
        ex.push(
          `verdict: ${k} a=${da.matched}/${da.won} b=${db.matched}/${db.won}`,
        );
    }
  }
  for (const k of mb.keys())
    if (!ma.has(k)) {
      onlyB++;
      if (ex.length < 6) ex.push(`only ${path.basename(bDir)}: ${k}`);
    }
  const ua = unmatchedKeys(a);
  const ub = unmatchedKeys(b);
  const unmatchedOnlyA = [...ua].filter((k) => !ub.has(k));
  const unmatchedOnlyB = [...ub].filter((k) => !ua.has(k));
  console.log(
    `  vs ${path.basename(aDir)}: decls ${ma.size}/${mb.size}, identical counts ${same} ` +
      `(${((same / Math.max(ma.size, 1)) * 100).toFixed(2)}%), matched≠ ${matchedDiff}, won≠ ${wonDiff}, ` +
      `never-won verdict≠ ${verdictDiff}, only-a ${onlyA}, only-b ${onlyB}; ` +
      `unmatched rules ${ua.size}/${ub.size} (only-a ${unmatchedOnlyA.length}, only-b ${unmatchedOnlyB.length})`,
  );
  for (const e of ex) console.log(`      ${e.slice(0, 200)}`);
  for (const k of unmatchedOnlyA.slice(0, 3))
    console.log(`      unmatched only a: ${k.slice(0, 160)}`);
  for (const k of unmatchedOnlyB.slice(0, 3))
    console.log(`      unmatched only b: ${k.slice(0, 160)}`);
}

const fmt = (s: Summary) =>
  `obs ${s.observations}, rules ${s.rulesMatched}/${s.rulesTotal}, decls ${s.declarationsTotal} (won ${s.declarationsEverWon}, never ${s.declarationsNeverWon})`;

console.log(
  `fixtures: ${fixtures.length} × ${themes.length}; load avg ${loadAvg()}`,
);
const timings: Record<string, number> = {};

if (OLD) {
  const t = performance.now();
  const proc = Bun.spawn(
    [
      "bun",
      OLD,
      "--url",
      server.url,
      "--out",
      out("playwright"),
      ...(ONLY ? ["--only", ONLY] : []),
    ],
    {
      cwd: CCS_ROOT,
      stdout: Bun.file(results("usage-playwright-stdout.log")),
      stderr: "inherit",
    },
  );
  await proc.exited;
  timings.playwright = performance.now() - t;
  const s: UsageFile = await Bun.file(
    path.join(out("playwright"), "usage.json"),
  ).json();
  console.log(
    `\nplaywright (sequential): ${(timings.playwright / 1000).toFixed(1)}s  ${fmt(s.summary)}`,
  );
}

type RunOptions = Pick<
  UsageOptions,
  "engine" | "chromePath" | "matcher" | "emulate" | "concurrency"
>;
const chrome = { engine: "chrome", chromePath: PLAYWRIGHT_SHELL } as const;
const runs: { name: string; opts: RunOptions; vs: string[] }[] = [
  {
    name: "cdp-x1",
    opts: { ...chrome, matcher: "cdp", emulate: "cdp", concurrency: 1 },
    vs: ["playwright"],
  },
  {
    name: `cdp-x${K}`,
    opts: { ...chrome, matcher: "cdp", emulate: "cdp", concurrency: K },
    vs: ["playwright"],
  },
  {
    name: `dom-chrome-x${K}`,
    opts: { ...chrome, matcher: "dom", emulate: "cdp", concurrency: K },
    vs: ["playwright", `cdp-x${K}`],
  },
  {
    name: `dom-webkit-x${K}`,
    opts: {
      engine: "webkit",
      matcher: "dom",
      emulate: "cssom",
      concurrency: K,
    },
    vs: [`dom-chrome-x${K}`],
  },
];

for (const run of runs) {
  if (RUNS && !RUNS.some((r) => run.name.startsWith(r))) continue;
  // biome-ignore lint/performance/noAwaitInLoops: one run at a time, so timings don't contend
  const res = await runUsage({
    ...run.opts,
    baseUrl: server.url,
    fixtures,
    themes,
    outDir: out(run.name),
    states: true,
    sheetMarker: ".bx--",
  });
  timings[run.name] = res.ms;
  console.log(
    `\n${run.name}: ${(res.ms / 1000).toFixed(1)}s  ${fmt(res.summary)}`,
  );
  if (res.domStats.length) {
    const sum = (k: keyof (typeof res.domStats)[number]) =>
      res.domStats.reduce((n, s) => n + s[k], 0);
    console.log(
      `  dom: ${sum("elements")} elements, ${sum("matchCalls")} matches() calls, in-page prep ${sum("prepMs").toFixed(0)} ms + match ${sum("matchMs").toFixed(0)} ms; ` +
        `CSSOM↔source alignment ${sum("aligned")} ok / ${sum("unaligned")} unaligned; ${sum("skippedSelectors")} other-pseudo-element selectors skipped`,
    );
  }
  for (const v of run.vs) {
    // biome-ignore lint/performance/noAwaitInLoops: ordered output
    if (await Bun.file(path.join(out(v), "usage.json")).exists())
      await compare(out(v), out(run.name));
  }
}
server.stop();
Bun.WebView.closeAll();
await Bun.write(
  results("usage-timings.json"),
  JSON.stringify(
    { fixtures: fixtures.length, timings, loadavg: loadavg() },
    null,
    2,
  ),
);
