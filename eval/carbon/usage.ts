/**
 * cascade-usage: Playwright driver (e2e/cascade-usage.ts) vs Bun.WebView
 * with the CDP matcher (same Chromium build) vs the in-page `dom` matcher
 * on Chrome and WebKit.
 *
 *   CCS_ROOT=… bun eval/carbon/usage.ts [--only button] [--skip-old] [--runs cdp,dom]
 */
import { readdir } from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { serveFixtures } from "../../src/browser/serve";
import { runUsage, type UsageOptions } from "../../src/browser/usage";
import type {
  DeclarationStats,
  InventoryRule,
  Summary,
} from "../../src/core/usage";
import { CCS_ROOT, fixturesDir, results } from "./ccs";

const root = CCS_ROOT;
const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const ONLY = opt("only");
const K = Number(opt("concurrency") ?? 8);
const RUNS = opt("runs")?.split(",");
const out = (n: string) => results("usage", n);
const SHELL = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

const fixtures = (await readdir(path.join(root, "e2e/fixtures")))
  .filter((f) => f.endsWith(".html"))
  .map((f) => f.slice(0, -5))
  .filter((f) => !ONLY || f.includes(ONLY))
  .sort();
const themes = ["white", "g100"];
const server = serveFixtures(await fixturesDir());

interface UsageFile {
  summary: Summary;
  declarations: DeclarationStats[];
  unmatched: InventoryRule[];
}

const norm = (s: string) => s.replace(/[\s"'\\]+/g, "").replace(/::/g, ":");
const ctxNorm = (c: string) => c.split(" / ").map(norm).sort().join("/");
const declKey = (d: DeclarationStats) =>
  `${ctxNorm(d.context)}|${norm(d.selector)}|${d.property}|${norm(d.value)}|${d.important}`;

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
  let verdictDiff = 0; // "never won" classification differs
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
  const ua = new Set(
    a.unmatched.map((r) => `${ctxNorm(r.context)}|${norm(r.selector)}`),
  );
  const ub = new Set(
    b.unmatched.map((r) => `${ctxNorm(r.context)}|${norm(r.selector)}`),
  );
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
  `fixtures: ${fixtures.length} × ${themes.length}; load avg ${loadavg()
    .map((x) => x.toFixed(1))
    .join(" ")}`,
);
const timings: Record<string, number> = {};

if (!args.includes("--skip-old")) {
  const t = performance.now();
  const proc = Bun.spawn(
    [
      "bun",
      "e2e/cascade-usage.ts",
      "--url",
      server.url,
      "--out",
      out("playwright"),
      ...(ONLY ? ["--only", ONLY] : []),
    ],
    {
      cwd: root,
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

const runs: { name: string; opts: Partial<UsageOptions>; vs: string[] }[] = [
  {
    name: "cdp-x1",
    opts: {
      engine: "chrome",
      chromePath: SHELL,
      matcher: "cdp",
      emulate: "cdp",
      concurrency: 1,
    },
    vs: ["playwright"],
  },
  {
    name: `cdp-x${K}`,
    opts: {
      engine: "chrome",
      chromePath: SHELL,
      matcher: "cdp",
      emulate: "cdp",
      concurrency: K,
    },
    vs: ["playwright"],
  },
  {
    name: `dom-chrome-x${K}`,
    opts: {
      engine: "chrome",
      chromePath: SHELL,
      matcher: "dom",
      emulate: "cdp",
      concurrency: K,
    },
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
  // biome-ignore lint/performance/noAwaitInLoops: sequential by design (one operation per view, or ordered output)
  const res = await runUsage({
    ...(run.opts as UsageOptions),
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
    const sum = (k: keyof (typeof res.domStats)[0]) =>
      res.domStats.reduce((n, s) => n + (s[k] as number), 0);
    console.log(
      `  dom: ${sum("elements")} elements, ${sum("matchCalls")} matches() calls, in-page prep ${sum("prepMs").toFixed(0)} ms + match ${sum("matchMs").toFixed(0)} ms; ` +
        `CSSOM↔source alignment ${sum("aligned")} ok / ${sum("unaligned")} unaligned; ${sum("skippedSelectors")} other-pseudo-element selectors skipped`,
    );
  }
  for (const v of run.vs) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential by design (one operation per view, or ordered output)
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
