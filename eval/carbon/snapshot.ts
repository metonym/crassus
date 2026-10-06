/**
 * Computed-style snapshot: Playwright (e2e/cascade-snapshot.ts) vs the
 * Bun.WebView port, same Chromium build (Playwright's headless shell), plus
 * the engine-agnostic modes and WebKit.
 *
 *   CCS_ROOT=… bun eval/carbon/snapshot.ts [--only button] [--skip-old]
 */
import { readdir } from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { serveFixtures } from "../../src/browser/serve";
import {
  type CaptureOptions,
  capture,
  type Snapshot,
} from "../../src/browser/snapshot";
import { CCS_ROOT, fixturesDir, oldTool, results } from "./ccs";

const root = CCS_ROOT;
const args = process.argv.slice(2);
const OLD = args.includes("--skip-old")
  ? undefined
  : oldTool("e2e/cascade-snapshot.ts", "pass --skip-old");
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const ONLY = opt("only");
const CONCURRENCY = Number(opt("concurrency") ?? 8);
const out = (n: string) => results("snap", n);
const SHELL = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

const fixtures = (await readdir(path.join(root, "e2e/fixtures")))
  .filter((f) => f.endsWith(".html"))
  .map((f) => f.slice(0, -5))
  .filter((f) => !ONLY || f.includes(ONLY))
  .sort();
const themes = ["white", "g100"];
const server = serveFixtures(await fixturesDir());

interface Compare {
  unsupported: number;
  subpixel: number;
  files: number;
  entries: number;
  props: number;
  changed: number;
  missing: number;
  added: number;
  groups: [string, number][];
}

const NUM = /-?\d*\.?\d+(?:e-?\d+)?/g;
function nearlyEqual(a: string, b: string): boolean {
  if (a.replace(NUM, "#") !== b.replace(NUM, "#")) return false;
  const na = a.match(NUM) ?? [];
  const nb = b.match(NUM) ?? [];
  return na.every((x, i) => Math.abs(Number(x) - Number(nb[i])) < 0.01);
}

async function compare(a: string, b: string): Promise<Compare> {
  const files = (await readdir(a)).filter((f) => f.endsWith(".json")).sort();
  const groups = new Map<string, number>();
  const r: Compare = {
    unsupported: 0,
    subpixel: 0,
    files: 0,
    entries: 0,
    props: 0,
    changed: 0,
    missing: 0,
    added: 0,
    groups: [],
  };
  for (const f of files) {
    const fb = Bun.file(path.join(b, f));
    // biome-ignore lint/performance/noAwaitInLoops: sequential by design (one operation per view, or ordered output)
    if (!(await fb.exists())) continue;
    r.files++;
    const sa: Snapshot = await Bun.file(path.join(a, f)).json();
    const sb: Snapshot = await fb.json();
    for (const key of Object.keys(sa)) {
      r.entries++;
      const va = sa[key];
      const vb = sb[key];
      if (!vb) {
        r.missing++;
        continue;
      }
      for (const p of Object.keys(va)) {
        r.props++;
        if (va[p] === vb[p]) continue;
        // Cross-engine noise: a property one engine doesn't implement, and
        // sub-pixel rounding (18.0001px vs 18.00008px).
        if (va[p] === undefined || vb[p] === undefined) {
          r.unsupported++;
          continue;
        }
        if (nearlyEqual(va[p], vb[p])) {
          r.subpixel++;
          continue;
        }
        r.changed++;
        const g = `${p}: ${va[p]} → ${vb[p]}`;
        groups.set(g, (groups.get(g) ?? 0) + 1);
      }
    }
    for (const key of Object.keys(sb)) if (!sa[key]) r.added++;
  }
  r.groups = [...groups].sort((x, y) => y[1] - x[1]).slice(0, 8);
  return r;
}

function report(label: string, c: Compare) {
  const pct = c.props ? ((1 - c.changed / c.props) * 100).toFixed(3) : "n/a";
  console.log(
    `  vs ${label}: ${c.files} files, ${c.entries} entries, ${c.props} props; ` +
      `${c.changed} changed (${pct}% identical), ${c.missing} entries missing, ${c.added} extra` +
      (c.unsupported || c.subpixel
        ? `; ignored: ${c.unsupported} unsupported-prop, ${c.subpixel} sub-pixel`
        : ""),
  );
  for (const [g, n] of c.groups) console.log(`      ${n}×  ${g.slice(0, 140)}`);
}

const timings: Record<string, number> = {};
console.log(
  `fixtures: ${fixtures.length} × themes ${themes.length}; load avg ${loadavg()
    .map((x) => x.toFixed(1))
    .join(" ")}`,
);

if (OLD) {
  const t = performance.now();
  const proc = Bun.spawn(
    [
      "bun",
      OLD,
      "capture",
      out("playwright"),
      "--url",
      server.url,
      ...(ONLY ? ["--only", ONLY] : []),
    ],
    { cwd: root, stdout: "ignore", stderr: "inherit" },
  );
  await proc.exited;
  timings.playwright = performance.now() - t;
  console.log(
    `\nplaywright (sequential): ${(timings.playwright / 1000).toFixed(1)}s`,
  );
}

const runs: { name: string; opts: Partial<CaptureOptions>; vs: string[] }[] = [
  {
    name: "webview-cdp-x1",
    opts: {
      engine: "chrome",
      chromePath: SHELL,
      states: "cdp",
      emulate: "cdp",
      concurrency: 1,
    },
    vs: ["playwright"],
  },
  {
    name: `webview-cdp-x${CONCURRENCY}`,
    opts: {
      engine: "chrome",
      chromePath: SHELL,
      states: "cdp",
      emulate: "cdp",
      concurrency: CONCURRENCY,
    },
    vs: ["playwright"],
  },
  {
    name: `webview-rewrite-x${CONCURRENCY}`,
    opts: {
      engine: "chrome",
      chromePath: SHELL,
      states: "rewrite",
      emulate: "cdp",
      concurrency: CONCURRENCY,
    },
    vs: ["playwright"],
  },
  {
    name: `webview-agnostic-x${CONCURRENCY}`,
    opts: {
      engine: "chrome",
      chromePath: SHELL,
      states: "rewrite",
      emulate: "cssom",
      concurrency: CONCURRENCY,
    },
    vs: ["playwright"],
  },
  {
    name: `webkit-x${CONCURRENCY}`,
    opts: {
      engine: "webkit",
      states: "rewrite",
      emulate: "cssom",
      concurrency: CONCURRENCY,
    },
    vs: [`webview-agnostic-x${CONCURRENCY}`],
  },
];

for (const run of runs) {
  if (
    opt("runs") &&
    !opt("runs")
      ?.split(",")
      .some((r) => run.name.startsWith(r))
  )
    continue;
  // biome-ignore lint/performance/noAwaitInLoops: sequential by design (one operation per view, or ordered output)
  const res = await capture({
    ...(run.opts as CaptureOptions),
    baseUrl: server.url,
    fixtures,
    themes,
    outDir: out(run.name),
  });
  timings[run.name] = res.ms;
  console.log(
    `\n${run.name}: ${(res.ms / 1000).toFixed(1)}s (${res.pages} pages)`,
  );
  for (const v of run.vs) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential by design (one operation per view, or ordered output)
    if (await Bun.file(path.join(out(v), `${fixtures[0]}.white.json`)).exists())
      report(v, await compare(out(v), out(run.name)));
  }
}
server.stop();
Bun.WebView.closeAll();
await Bun.write(
  results("snapshot-timings.json"),
  JSON.stringify(
    { fixtures: fixtures.length, themes, timings, loadavg: loadavg() },
    null,
    2,
  ),
);
