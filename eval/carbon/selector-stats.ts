/**
 * selector-stats: Playwright harness vs the Bun.WebView port, same Chromium
 * build, same vite dev server (the harness edits the injected <style>).
 *
 *   CCS_ROOT=… bun eval/carbon/selector-stats.ts [scenario] [--runs 5] [--recalc-runs 10]
 */
import { loadavg } from "node:os";
import path from "node:path";
import { CCS_ROOT, results } from "./ccs";

const root = CCS_ROOT;
const args = process.argv.slice(2);
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const scenario = args[0] && !args[0].startsWith("--") ? args[0] : "link-icons";
const RUNS = opt("runs", "5");
const RECALC = opt("recalc-runs", "10");
const PORT = 4391;
const URL = `http://localhost:${PORT}`;
const SHELL = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const outDir = results("selector-stats");

const vite = Bun.spawn(
  [
    "bunx",
    "vite",
    "--config",
    "e2e/vite.config.ts",
    "--port",
    String(PORT),
    "--strictPort",
  ],
  { cwd: root, stdout: "ignore", stderr: "ignore" },
);
for (let i = 0; i < 100; i++) {
  try {
    // biome-ignore lint/performance/noAwaitInLoops: sequential by design (one operation per view, or ordered output)
    if ((await fetch(URL)).status) break;
  } catch {}
  await Bun.sleep(200);
}

interface Row {
  selector: string;
  sheet: string;
  elapsed: number;
  attempts: number;
  matches: number;
}
interface Report {
  elements: number;
  recalc: {
    variant: string;
    removedSelectors: number;
    ms: { median: number };
    diffMs: { median: number; iqr: number };
  }[];
  traced: {
    attempts: { median: number };
    elementCount: { median: number };
    selectorTotalMs: { median: number };
    updateLayoutTreeMs: { median: number };
  };
  top: Row[];
}

async function run(
  label: string,
  script: string,
  env: Record<string, string> = {},
) {
  const json = path.join(outDir, `${label}.json`);
  const t = performance.now();
  const p = Bun.spawn(
    [
      "bun",
      script,
      scenario,
      "--runs",
      RUNS,
      "--recalc-runs",
      RECALC,
      "--json",
      json,
      "--url",
      URL,
    ],
    {
      cwd: root,
      stdout: "ignore",
      stderr: "inherit",
      env: { ...process.env, ...env },
    },
  );
  await p.exited;
  const ms = performance.now() - t;
  const [report]: Report[] = await Bun.file(json).json();
  return { ms, report };
}

try {
  console.log(
    `scenario ${scenario}, runs ${RUNS}, recalc-runs ${RECALC}; load avg ${loadavg()
      .map((x) => x.toFixed(1))
      .join(" ")}`,
  );
  await Bun.$`mkdir -p ${outDir}`;
  // Warm vite's transform cache so neither side pays for it.
  await fetch(
    `${URL}/${scenario === "link-icons" ? "link" : "data-table"}.html`,
  );
  const old = await run("playwright", "e2e/selector-stats.ts");
  const neu = await run(
    "webview",
    path.join(import.meta.dir, "selector-stats-harness.ts"),
    { CR_CHROME_PATH: SHELL },
  );

  const a = old.report;
  const b = neu.report;
  console.log(
    `\nwall: playwright ${(old.ms / 1000).toFixed(1)}s, webview ${(neu.ms / 1000).toFixed(1)}s`,
  );
  console.log(`elements: ${a.elements} / ${b.elements}`);
  console.log(
    `traced attempts (median): ${a.traced.attempts.median} / ${b.traced.attempts.median}`,
  );
  console.log(
    `elements recalculated: ${a.traced.elementCount.median} / ${b.traced.elementCount.median}`,
  );
  console.log(
    `sum selector ms: ${a.traced.selectorTotalMs.median.toFixed(2)} / ${b.traced.selectorTotalMs.median.toFixed(2)}`,
  );
  console.log(
    `UpdateLayoutTree ms: ${a.traced.updateLayoutTreeMs.median.toFixed(2)} / ${b.traced.updateLayoutTreeMs.median.toFixed(2)}`,
  );

  const byB = new Map(b.top.map((r) => [`${r.sheet}|${r.selector}`, r]));
  let both = 0;
  let countersEqual = 0;
  const ranksA: number[] = [];
  const ranksB: number[] = [];
  a.top.forEach((r, i) => {
    const m = byB.get(`${r.sheet}|${r.selector}`);
    if (!m) return;
    both++;
    if (m.attempts === r.attempts && m.matches === r.matches) countersEqual++;
    ranksA.push(i);
    ranksB.push(b.top.indexOf(m));
  });
  // Spearman over the shared top-N selectors.
  const rank = (xs: number[]) => {
    const s = [...xs].map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(xs.length);
    s.forEach(([, i], k) => {
      r[i] = k;
    });
    return r;
  };
  const ra = rank(ranksA);
  const rb = rank(ranksB);
  const n = ra.length;
  const d2 = ra.reduce(
    (acc: number, x: number, i: number) => acc + (x - rb[i]) ** 2,
    0,
  );
  const rho = n > 1 ? 1 - (6 * d2) / (n * (n * n - 1)) : 1;
  console.log(
    `top-${a.top.length} selectors: ${both} shared, ${countersEqual}/${both} with identical attempts+matches, Spearman ρ of elapsed rank ${rho.toFixed(2)}`,
  );
  console.log(
    "untraced RecalcStyleDuration (median ms; paired diff vs baseline):",
  );
  a.recalc.forEach((v, i) => {
    const w = b.recalc[i];
    console.log(
      `  ${v.variant.padEnd(26)} removed ${v.removedSelectors}/${w.removedSelectors}  ` +
        `${v.ms.median.toFixed(3)} / ${w.ms.median.toFixed(3)}  diff ${v.diffMs.median.toFixed(3)} / ${w.diffMs.median.toFixed(3)}`,
    );
  });
} finally {
  vite.kill();
}
