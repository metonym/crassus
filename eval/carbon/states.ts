/**
 * Forced states on today's fixtures (white, 1280x900), three ways: CDP
 * forcing every reachable state (0.2's), CDP with the state selector index
 * (forcing only where some rule uses the state, reading the rest
 * unforced), and rewriting state selectors in place. Every record must
 * match the first; the state phase is timed and its CDP calls counted.
 *
 *   CCS_ROOT=… bun eval/carbon/states.ts [--only <fixture>] [--concurrency 4]
 */
import { serveFixtures } from "../../src/browser/serve";
import { capturePage, type StateStats } from "../../src/browser/snapshot";
import { visitPages } from "../../src/browser/view";
import type { Snapshot } from "../../src/core/snapshot-diff";
import { CONCURRENCY, fixtureOpts, quiet } from "./cases";
import { loadAvg, opt } from "./ccs";

const ONLY = opt("only");
const PSEUDO_RE = /::.*$/;
const PART_RE = /[.[@]/;
const STATE_RE = /@\w+\^?/;
const MODES = [
  { name: "cdp, every state", states: "cdp", stateIndex: false },
  { name: "cdp, state index", states: "cdp", stateIndex: true },
  { name: "rewrite", states: "rewrite", stateIndex: false },
] as const;

const { dir, fixtures: all } = await fixtureOpts();
const fixtures = all.filter((f) => !ONLY || f.includes(ONLY));
const server = serveFixtures(dir);
const runs: { snaps: Map<string, Snapshot>; stats: StateStats; ms: number }[] =
  [];
try {
  for (const mode of MODES) {
    // biome-ignore lint/performance/noAwaitInLoops: one run at a time
    await quiet();
    const snaps = new Map<string, Snapshot>();
    const stats: StateStats = { ms: 0, cdpCalls: 0, forced: 0, copied: 0 };
    let states = 0;
    const r = await visitPages(
      {
        baseUrl: server.url,
        fixtures,
        themes: ["white"],
        engine: "chrome",
        concurrency: CONCURRENCY,
        emulate: "cdp",
        readySelector: "#app > *, body > nav",
      },
      async (view, job) => {
        const started = performance.now();
        const out = await capturePage(view, {
          states: mode.states,
          emulate: "cdp",
          stateIndex: mode.stateIndex,
        });
        states += performance.now() - started;
        snaps.set(job.label, out.snapshot);
        for (const k of ["ms", "cdpCalls", "forced", "copied"] as const)
          stats[k] += out.stats?.[k] ?? 0;
      },
    );
    runs.push({ snaps, stats, ms: r.ms });
    console.log(
      `${mode.name.padEnd(18)} ${(r.ms / 1000).toFixed(1).padStart(6)} s wall  capture ${(states / 1000).toFixed(1)} s (summed over tabs)  ${mode.states === "cdp" ? `state phase ${(stats.ms / 1000).toFixed(1)} s, ${stats.cdpCalls} CDP calls, ${stats.forced} states forced, ${stats.copied} read unforced` : ""}  (load ${loadAvg()})`,
    );
  }
} finally {
  server.stop();
}

/** Records that differ from the first run's: missing, extra, or another value. */
function differences(a: Map<string, Snapshot>, b: Map<string, Snapshot>) {
  let entries = 0;
  const examples: string[] = [];
  const kinds = new Map<string, number>();
  for (const [page, snap] of a) {
    const other = b.get(page) ?? {};
    const keys = new Set([...Object.keys(snap), ...Object.keys(other)]);
    for (const key of keys) {
      const x = snap[key];
      const y = other[key];
      const same =
        x &&
        y &&
        Object.keys(x).length === Object.keys(y).length &&
        Object.entries(x).every(([p, v]) => y[p] === v);
      if (same) continue;
      entries++;
      const tag = key
        .replace(PSEUDO_RE, "")
        .split(">")
        .at(-1)
        ?.split(PART_RE)[0];
      const prop =
        x && y ? Object.keys(x).find((p) => x[p] !== y[p]) : undefined;
      const kind = `${tag} ${key.match(STATE_RE)?.[0] ?? ""} ${x && y ? prop : "presence"}`;
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      if (examples.length < 5)
        examples.push(
          `${page} ${key}${prop ? ` ${prop}: ${x?.[prop]} vs ${y?.[prop]}` : x ? " (missing)" : " (extra)"}`,
        );
    }
  }
  return { entries, examples, kinds: [...kinds].sort((a, b) => b[1] - a[1]) };
}

const total = [...runs[0].snaps.values()].reduce(
  (n, s) => n + Object.keys(s).length,
  0,
);
for (const [i, mode] of MODES.entries()) {
  if (i === 0) continue;
  const d = differences(runs[0].snaps, runs[i].snaps);
  console.log(
    `${mode.name}: ${d.entries} of ${total} records differ from ${MODES[0].name}${d.examples.length ? `\n  ${d.examples.join("\n  ")}\n  by element, state and property: ${d.kinds.map(([k, n]) => `${k} ×${n}`).join("; ")}` : ""}`,
  );
}
