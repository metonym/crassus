// crassus/browser loads on first use, so `dead` and `diff` don't pay for it.
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join, relative, resolve } from "node:path";
import type { UsageFile } from "../browser/usage";
import type { BrowserConfig, Config } from "../core/config";
import { atRef } from "./baseline";
import type { Io } from "./main";
import { build, isOneOf, UsageError } from "./project";
import { formatSnapshotDiff, refLabel, type Summary, seconds } from "./report";

/** Command-line overrides of `browser` in the config. */
export interface BrowserFlags {
  only?: string;
  themes?: string;
  viewport?: string[];
  noStates?: boolean;
  engine?: string;
  matcher?: string;
  concurrency?: string;
  url?: string;
}

const VIEWPORT_RE = /^(\d+)x(\d+)$/;
const TRAILING_SLASH_RE = /\/$/;
const ENGINES = ["chrome", "webkit"] as const;
const MATCHERS = ["cdp", "dom"] as const;
const EMULATE = { chrome: "cdp", webkit: "cssom" } as const;

/** Half the cores, at most 4: each tab is a renderer process. */
const defaultConcurrency = () =>
  Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2)));

function parseViewport(text: string) {
  const m = VIEWPORT_RE.exec(text);
  if (!m || Number(m[1]) < 1 || Number(m[2]) < 1)
    throw new UsageError(`--viewport takes WxH (1280x900), not ${text}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

function settings(config: Config, flags: BrowserFlags) {
  const { browser } = config;
  if (!browser)
    throw new UsageError(
      "no fixture pages: add `browser: { fixtures }` to crassus.config.ts",
    );
  const engine = flags.engine ?? browser.engine ?? "chrome";
  if (!isOneOf(ENGINES, engine))
    throw new UsageError(`unknown engine ${engine} (chrome or webkit)`);
  const concurrency = Number(
    flags.concurrency ?? browser.concurrency ?? defaultConcurrency(),
  );
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new UsageError(`--concurrency takes a positive integer`);
  const themes = flags.themes
    ? flags.themes.split(",").filter(Boolean)
    : browser.themes;
  return {
    browser,
    states: !flags.noStates,
    /** What `capture` and `runUsage` share. */
    pages: {
      engine,
      concurrency,
      chromePath: browser.chromePath,
      // Without themes: one run per page, and no attribute to set.
      themes: themes?.length ? themes : ["default"],
      themeAttribute: themes?.length
        ? (browser.themeAttribute ?? "theme")
        : null,
      viewports: flags.viewport?.length
        ? flags.viewport.map(parseViewport)
        : browser.viewports,
      readySelector: browser.readySelector,
      readyTimeoutMs: browser.readyTimeoutMs,
    },
  };
}

/** Builds and serves the fixtures in `root`, unless `--url` points at a running server. */
async function withFixtures<T>(
  root: string,
  browser: BrowserConfig,
  flags: BrowserFlags,
  fn: (baseUrl: string, fixtures: string[]) => Promise<T>,
): Promise<T> {
  const { dir, build: command } =
    typeof browser.fixtures === "string"
      ? { dir: browser.fixtures, build: undefined }
      : browser.fixtures;
  const building = flags.url ? undefined : command;
  if (building) await build(building, root);
  const path = resolve(root, dir);
  if (!existsSync(path))
    throw new UsageError(
      `${dir} doesn't exist${building ? ` after \`${building}\`` : ""}`,
    );
  const fixtures = (await readdir(path))
    .filter((f) => f.endsWith(".html"))
    .map((f) => f.slice(0, -5))
    .filter((f) => !flags.only || f.includes(flags.only))
    .sort();
  if (fixtures.length === 0)
    throw new UsageError(
      `no .html fixtures in ${dir}${flags.only ? ` matching ${flags.only}` : ""}`,
    );
  if (flags.url) return fn(flags.url.replace(TRAILING_SLASH_RE, ""), fixtures);
  const { serveFixtures } = await import("../browser/serve");
  const server = serveFixtures(path);
  try {
    return await fn(server.url, fixtures);
  } finally {
    server.stop();
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const pagesLine = (
  pages: number,
  fixtures: number,
  themes: number,
  viewports: number,
) =>
  `${plural(pages, "page")} (${plural(fixtures, "fixture")} × ${plural(themes, "theme")} × ${plural(viewports, "viewport")})`;
const notReadyLine = (
  pages: string[],
  readySelector: string | undefined,
  anyway: string,
) =>
  `crassus: ${plural(pages.length, "page")} never matched readySelector ${JSON.stringify(readySelector)} (${anyway} anyway): ${pages.join(", ")}`;

/** `crassus capture <outDir> [--base <ref>]`. Exit 1 when a page never got ready. */
export async function captureCommand(opts: {
  config: Config;
  flags: BrowserFlags;
  outDir: string;
  base?: string;
  io: Io;
}): Promise<number> {
  const { flags, io, base } = opts;
  const { cwd } = io;
  const { browser, states, pages } = settings(opts.config, flags);
  if (base && flags.url)
    throw new UsageError("--base builds its own fixtures: drop --url");
  const outDir = resolve(cwd, opts.outDir);
  const { capture } = await import("../browser/snapshot");
  const run = (root: string) =>
    withFixtures(root, browser, flags, async (baseUrl, fixtures) => {
      const r = await capture({
        ...pages,
        baseUrl,
        fixtures,
        outDir,
        states: states
          ? pages.engine === "chrome"
            ? "cdp"
            : "rewrite"
          : false,
        emulate: EMULATE[pages.engine],
        settleMs: browser.settleMs,
      });
      return { ...r, fixtures: fixtures.length };
    });
  const { sha, result: r } = base
    ? await atRef(cwd, base, run)
    : { sha: "", result: await run(cwd) };
  const at = base ? ` at ${refLabel(base, sha)}` : "";
  io.out(
    `crassus: captured ${pagesLine(r.pages, r.fixtures, pages.themes.length, pages.viewports?.length ?? 1)}${at} into ${relative(cwd, outDir) || "."} in ${seconds(r.ms)}`,
  );
  if (r.notReady.length === 0) return 0;
  io.err(notReadyLine(r.notReady, pages.readySelector, "captured"));
  return 1;
}

/** `crassus snapshot-diff <baseDir> <headDir>`. Exit 1 when anything differs. */
export async function snapshotDiffCommand(opts: {
  dirs: string[];
  format: "human" | "json";
  io: Io;
  summary?: Summary;
}): Promise<number> {
  if (opts.dirs.length !== 2)
    throw new UsageError("snapshot-diff takes two directories (base, head)");
  const [base, head] = opts.dirs.map((d) => {
    const path = resolve(opts.io.cwd, d);
    if (!existsSync(path)) throw new UsageError(`no such directory: ${d}`);
    return path;
  });
  const { diffSnapshots, IncompleteCaptureError } = await import(
    "../browser/snapshot-diff"
  );
  const diff = await diffSnapshots(base, head).catch((e) => {
    if (!(e instanceof IncompleteCaptureError)) throw e;
    throw new UsageError(
      e.message.replace(e.dir, relative(opts.io.cwd, e.dir) || "."),
    );
  });
  await opts.summary?.(`crassus snapshot-diff ${opts.dirs.join(" ")}`, () =>
    formatSnapshotDiff(diff, "human"),
  );
  opts.io.out(formatSnapshotDiff(diff, opts.format));
  // Properties one side didn't record, and changes no one can see, are
  // listed for review, not failed on.
  const differs =
    diff.groups.some((g) => !g.invisible) ||
    diff.pages.some((p) => p.removed.length > 0 || p.added.length > 0) ||
    diff.onlyBase.length > 0 ||
    diff.onlyHead.length > 0;
  return differs ? 1 : 0;
}

/** `crassus usage`: writes usage.json and report.md. Always exit 0: evidence, not proof. */
export async function usageCommand(opts: {
  config: Config;
  flags: BrowserFlags;
  outDir?: string;
  io: Io;
}): Promise<number> {
  const { flags, io } = opts;
  const { cwd } = io;
  const { browser, states, pages } = settings(opts.config, flags);
  const { sheetMarker } = browser;
  if (!sheetMarker)
    throw new UsageError(
      "usage needs `browser.sheetMarker`: text only the library stylesheet contains",
    );
  const matcher = flags.matcher ?? "dom";
  if (!isOneOf(MATCHERS, matcher))
    throw new UsageError(`unknown matcher ${matcher} (cdp or dom)`);
  if (matcher === "cdp" && pages.engine !== "chrome")
    throw new UsageError("--matcher cdp needs --engine chrome");
  const outDir = resolve(cwd, opts.outDir ?? ".crassus/usage");
  await mkdir(outDir, { recursive: true });
  const { runUsage } = await import("../browser/usage");
  const { formatUsageReport } = await import("./usage-report");
  const r = await withFixtures(cwd, browser, flags, (baseUrl, fixtures) =>
    runUsage({
      ...pages,
      baseUrl,
      fixtures,
      outDir,
      matcher,
      emulate: EMULATE[pages.engine],
      states,
      sheetMarker,
    }),
  );
  const usage: UsageFile = await Bun.file(join(outDir, "usage.json")).json();
  await Bun.write(
    join(outDir, "report.md"),
    formatUsageReport(usage, {
      themes: pages.themes,
      viewports: pages.viewports,
      states,
      readySelector: pages.readySelector,
    }),
  );
  const { summary } = r;
  const where = relative(cwd, outDir) || ".";
  io.out(
    [
      `crassus: usage over ${pagesLine(summary.fixtures * summary.themes * summary.viewports, summary.fixtures, summary.themes, summary.viewports)} in ${seconds(r.ms)} (evidence, bounded by the fixtures)`,
      `  ${summary.declarationsNeverWon} of ${summary.declarationsTotal} matched declarations never won (${usage.fold} fold candidates); ${usage.unmatched.length} rules never matched`,
      `  ${join(where, "usage.json")}, ${join(where, "report.md")}`,
    ].join("\n"),
  );
  if (r.notReady.length)
    io.err(notReadyLine(r.notReady, pages.readySelector, "read"));
  return 0;
}
