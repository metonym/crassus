/**
 * `capture`, `snapshot-diff` and `usage`: the real-browser rungs over the
 * config's fixture pages. crassus/browser loads on first use, so `dead` and
 * `diff` don't pay for it.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { BrowserConfig, Config } from "../core/config";
import { atRef } from "./baseline";
import { build, UsageError } from "./project";
import { formatSnapshotDiff } from "./report";

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

interface Output {
  out: (text: string) => void;
  err: (text: string) => void;
}

const VIEWPORT_RE = /^(\d+)x(\d+)$/;
const TRAILING_SLASH_RE = /\/$/;
const ENGINES = ["chrome", "webkit"] as const;

function parseViewport(text: string) {
  const m = VIEWPORT_RE.exec(text);
  if (!m || Number(m[1]) < 1 || Number(m[2]) < 1)
    throw new UsageError(`--viewport takes WxH (1280x900), not ${text}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** The config's `browser` block with the flags applied. */
function settings(config: Config, flags: BrowserFlags) {
  const browser: BrowserConfig | undefined = config.browser;
  if (!browser)
    throw new UsageError(
      "no fixture pages: add `browser: { fixtures }` to crassus.config.ts",
    );
  const engine = (flags.engine ?? browser.engine ?? "chrome") as
    | "chrome"
    | "webkit";
  if (!ENGINES.includes(engine))
    throw new UsageError(`unknown engine ${engine} (chrome or webkit)`);
  const concurrency = Number(flags.concurrency ?? browser.concurrency ?? 8);
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new UsageError(`--concurrency takes a positive integer`);
  const themes = flags.themes
    ? flags.themes.split(",").filter(Boolean)
    : browser.themes;
  return {
    browser,
    engine,
    concurrency,
    chromePath: browser.chromePath,
    // Without themes: one run per page, and no attribute to set.
    themes: themes?.length ? themes : ["default"],
    themeAttribute: themes?.length ? (browser.themeAttribute ?? "theme") : null,
    viewports: flags.viewport?.length
      ? flags.viewport.map(parseViewport)
      : browser.viewports,
    readySelector: browser.readySelector,
    readyTimeoutMs: browser.readyTimeoutMs,
    settleMs: browser.settleMs,
    states: !flags.noStates,
  };
}

/**
 * Builds the fixtures in `root` (unless `--url` points at a running
 * server), serves them, and runs `fn` on their names.
 */
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
  if (command && !flags.url) await build(command, root);
  const path = resolve(root, dir);
  if (!existsSync(path))
    throw new UsageError(
      `${dir} doesn't exist${command && !flags.url ? ` after \`${command}\`` : ""}`,
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

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const pagesLine = (
  pages: number,
  fixtures: number,
  themes: number,
  viewports: number,
) =>
  `${plural(pages, "page")} (${plural(fixtures, "fixture")} × ${plural(themes, "theme")} × ${plural(viewports, "viewport")})`;

/** `crassus capture <outDir> [--base <ref>]`. Exit 1 when a page never got ready. */
export async function captureCommand(opts: {
  cwd: string;
  config: Config;
  flags: BrowserFlags;
  outDir: string;
  base?: string;
  io: Output;
}): Promise<number> {
  const { cwd, flags, io } = opts;
  const s = settings(opts.config, flags);
  if (opts.base && flags.url)
    throw new UsageError("--base builds its own fixtures: drop --url");
  const outDir = resolve(cwd, opts.outDir);
  const { capture } = await import("../browser/snapshot");
  const run = (root: string) =>
    withFixtures(root, s.browser, flags, async (baseUrl, fixtures) => {
      const r = await capture({
        baseUrl,
        fixtures,
        outDir,
        themes: s.themes,
        themeAttribute: s.themeAttribute,
        viewports: s.viewports,
        engine: s.engine,
        chromePath: s.chromePath,
        concurrency: s.concurrency,
        states: s.states ? (s.engine === "chrome" ? "cdp" : "rewrite") : false,
        emulate: s.engine === "chrome" ? "cdp" : "cssom",
        readySelector: s.readySelector,
        readyTimeoutMs: s.readyTimeoutMs,
        settleMs: s.settleMs,
      });
      return { ...r, fixtures: fixtures.length };
    });
  let at = "";
  let r: Awaited<ReturnType<typeof run>>;
  if (opts.base) {
    const { sha, result } = await atRef(cwd, opts.base, run);
    at = ` at ${sha.startsWith(opts.base) ? opts.base : `${opts.base} (${sha.slice(0, 9)})`}`;
    r = result;
  } else {
    r = await run(cwd);
  }
  io.out(
    `crassus: captured ${pagesLine(r.pages, r.fixtures, s.themes.length, s.viewports?.length ?? 1)}${at} into ${relative(cwd, outDir) || "."} in ${seconds(r.ms)}`,
  );
  if (r.notReady.length === 0) return 0;
  io.err(
    `crassus: ${plural(r.notReady.length, "page")} never matched readySelector ${JSON.stringify(s.readySelector)} (captured anyway): ${r.notReady.join(", ")}`,
  );
  return 1;
}

/** `crassus snapshot-diff <baseDir> <headDir>`. Exit 1 when anything differs. */
export async function snapshotDiffCommand(opts: {
  cwd: string;
  dirs: string[];
  format: "human" | "json";
  io: Output;
}): Promise<number> {
  if (opts.dirs.length !== 2)
    throw new UsageError("snapshot-diff takes two directories (base, head)");
  const [base, head] = opts.dirs.map((d) => {
    const path = resolve(opts.cwd, d);
    if (!existsSync(path)) throw new UsageError(`no such directory: ${d}`);
    return path;
  });
  const { diffSnapshots } = await import("../browser/snapshot-diff");
  const diff = await diffSnapshots(base, head);
  opts.io.out(formatSnapshotDiff(diff, opts.format));
  const differs =
    diff.groups.length > 0 ||
    diff.pages.length > 0 ||
    diff.onlyBase.length > 0 ||
    diff.onlyHead.length > 0;
  return differs ? 1 : 0;
}

/** `crassus usage`: writes usage.json and report.md. Always exit 0: evidence, not proof. */
export async function usageCommand(opts: {
  cwd: string;
  config: Config;
  flags: BrowserFlags;
  outDir?: string;
  io: Output;
}): Promise<number> {
  const { cwd, flags, io } = opts;
  const s = settings(opts.config, flags);
  const sheetMarker = s.browser.sheetMarker;
  if (!sheetMarker)
    throw new UsageError(
      "usage needs `browser.sheetMarker`: text only the library stylesheet contains",
    );
  const matcher = (flags.matcher ?? "dom") as "cdp" | "dom";
  if (matcher !== "cdp" && matcher !== "dom")
    throw new UsageError(`unknown matcher ${matcher} (cdp or dom)`);
  if (matcher === "cdp" && s.engine !== "chrome")
    throw new UsageError("--matcher cdp needs --engine chrome");
  const outDir = resolve(cwd, opts.outDir ?? ".crassus/usage");
  await mkdir(outDir, { recursive: true });
  const { runUsage } = await import("../browser/usage");
  const { formatUsageReport } = await import("./usage-report");
  const r = await withFixtures(cwd, s.browser, flags, (baseUrl, fixtures) =>
    runUsage({
      baseUrl,
      fixtures,
      outDir,
      themes: s.themes,
      themeAttribute: s.themeAttribute,
      viewports: s.viewports,
      engine: s.engine,
      chromePath: s.chromePath,
      concurrency: s.concurrency,
      matcher,
      emulate: s.engine === "chrome" ? "cdp" : "cssom",
      states: s.states,
      sheetMarker,
      readySelector: s.readySelector,
      readyTimeoutMs: s.readyTimeoutMs,
    }),
  );
  const usage = await Bun.file(join(outDir, "usage.json")).json();
  await Bun.write(
    join(outDir, "report.md"),
    formatUsageReport(usage, {
      themes: s.themes,
      viewports: s.viewports,
      states: s.states,
      readySelector: s.readySelector,
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
    io.err(
      `crassus: ${plural(r.notReady.length, "page")} never matched readySelector ${JSON.stringify(s.readySelector)} (read anyway): ${r.notReady.join(", ")}`,
    );
  return 0;
}
