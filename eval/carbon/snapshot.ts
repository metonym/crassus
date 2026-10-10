/**
 * Computed-style snapshot: Playwright (e2e/cascade-snapshot.ts) vs the
 * Bun.WebView port, same Chromium build (Playwright's headless shell), plus
 * the engine-agnostic modes and WebKit.
 *
 *   CCS_ROOT=… bun eval/carbon/snapshot.ts [--only button] [--skip-old] [--runs webview-cdp,webkit]
 */
import { readdir } from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { serveFixtures } from "../../src/browser/serve";
import {
  type CaptureOptions,
  capture,
  readSnapshot,
} from "../../src/browser/snapshot";
import type { Snapshot } from "../../src/core/snapshot-diff";
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
} from "./ccs";

const OLD = args.includes("--skip-old")
  ? undefined
  : oldTool("e2e/cascade-snapshot.ts", "pass --skip-old");
const ONLY = opt("only");
const K = Number(opt("concurrency") ?? 8);
const RUNS = opt("runs")?.split(",");
const out = (n: string) => results("snap", n);

const fixtures = await fixtureNames(ONLY);
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

// The old tool writes `<page>.json`; crassus `<page>.json.gz`.
const SNAPSHOT_RE = /\.json(?:\.gz)?$/;
async function snapshots(dir: string): Promise<Map<string, string>> {
  const files = (await readdir(dir).catch(() => [])).filter((f) =>
    SNAPSHOT_RE.test(f),
  );
  return new Map(
    files.map((f) => [f.replace(SNAPSHOT_RE, ""), path.join(dir, f)]),
  );
}
const load = (file: string): Promise<Snapshot> =>
  file.endsWith(".gz") ? readSnapshot(file) : Bun.file(file).json();

async function compare(a: string, b: string): Promise<Compare> {
  const [inA, inB] = await Promise.all([snapshots(a), snapshots(b)]);
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
  for (const [page, fa] of [...inA].sort()) {
    const fb = inB.get(page);
    if (!fb) continue;
    r.files++;
    // biome-ignore lint/performance/noAwaitInLoops: ordered output
    const [sa, sb] = await Promise.all([load(fa), load(fb)]);
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
  `fixtures: ${fixtures.length} × themes ${themes.length}; load avg ${loadAvg()}`,
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
    { cwd: CCS_ROOT, stdout: "ignore", stderr: "inherit" },
  );
  await proc.exited;
  timings.playwright = performance.now() - t;
  console.log(
    `\nplaywright (sequential): ${(timings.playwright / 1000).toFixed(1)}s`,
  );
}

type RunOptions = Pick<
  CaptureOptions,
  "engine" | "chromePath" | "states" | "emulate" | "concurrency"
>;
const chrome = { engine: "chrome", chromePath: PLAYWRIGHT_SHELL } as const;
const runs: { name: string; opts: RunOptions; vs: string[] }[] = [
  {
    name: "webview-cdp-x1",
    opts: { ...chrome, states: "cdp", emulate: "cdp", concurrency: 1 },
    vs: ["playwright"],
  },
  {
    name: `webview-cdp-x${K}`,
    opts: { ...chrome, states: "cdp", emulate: "cdp", concurrency: K },
    vs: ["playwright"],
  },
  {
    name: `webview-rewrite-x${K}`,
    opts: { ...chrome, states: "rewrite", emulate: "cdp", concurrency: K },
    vs: ["playwright"],
  },
  {
    name: `webview-agnostic-x${K}`,
    opts: { ...chrome, states: "rewrite", emulate: "cssom", concurrency: K },
    vs: ["playwright"],
  },
  {
    name: `webkit-x${K}`,
    opts: {
      engine: "webkit",
      states: "rewrite",
      emulate: "cssom",
      concurrency: K,
    },
    vs: [`webview-agnostic-x${K}`],
  },
];

for (const run of runs) {
  if (RUNS && !RUNS.some((r) => run.name.startsWith(r))) continue;
  // biome-ignore lint/performance/noAwaitInLoops: one run at a time, so timings don't contend
  const res = await capture({
    ...run.opts,
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
    // biome-ignore lint/performance/noAwaitInLoops: ordered output
    if ((await snapshots(out(v))).has(`${fixtures[0]}.white`))
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
