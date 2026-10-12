// crassus/browser loads on first use, so `dead` and `diff` don't pay for it.
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import type { Crops, Impact } from "../browser/compare";
import type { SnapshotDiff } from "../browser/snapshot-diff";
import type { TokenReport } from "../browser/tokens";
import type { UsageFile } from "../browser/usage";
import {
  type Approvals,
  blocking,
  buildCards,
  buildReport,
  type Card,
  type Report,
} from "../core/cards";
import type { BrowserConfig, Config } from "../core/config";
import { changedRules, nothingChanged } from "../core/impact";
import { atRef, baseStylesheets, cacheDir } from "./baseline";
import {
  attachSources,
  formatCardsBrief,
  formatCardsMarkdown,
  formatCardsSarif,
  formatCardsSummary,
  readApprovals,
  writeReport,
} from "./cards";
import type { DiffResult } from "./commands";
import type { Io } from "./main";
import {
  build,
  filesAsSheets,
  isOneOf,
  shownPath,
  stylesheets,
  UsageError,
} from "./project";
import { formatSnapshotDiff, refLabel, type Summary, seconds } from "./report";
import { mappedLocator, type Sheet } from "./sources";

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
  tokens?: string;
}

const VIEWPORT_RE = /^(\d+)x(\d+)$/;
const TRAILING_SLASH_RE = /\/$/;
const ENGINES = ["chrome", "webkit"] as const;
const MATCHERS = ["cdp", "dom"] as const;
export const EMULATE = { chrome: "cdp", webkit: "cssom" } as const;

/** Half the cores, at most 4: each tab is a renderer process. */
export const defaultConcurrency = () =>
  Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2)));

function parseViewport(text: string) {
  const m = VIEWPORT_RE.exec(text);
  if (!m || Number(m[1]) < 1 || Number(m[2]) < 1)
    throw new UsageError(`--viewport takes WxH (1280x900), not ${text}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

export function settings(config: Config, flags: BrowserFlags, io?: Io) {
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
  const tokens = flags.tokens ?? browser.tokens;
  // Told once a run; its time goes on the summary line (`throttled`).
  const throttle = { ms: 0, cores: 0 };
  return {
    throttle,
    browser,
    states: !flags.noStates,
    /** Design-token prefix to trace (`compare`, `bisect`, `tokens`). */
    // `cds-` or `--cds-`: the shell can't pass a value that starts with `--`.
    tokens: tokens && (tokens.startsWith("--") ? tokens : `--${tokens}`),
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
      allowNotReady: browser.allowNotReady,
      onBusy:
        io &&
        ((w: { load: number; cores: number; ms: number }) => {
          if (!throttle.ms)
            io.err(
              `crassus: load average ${w.load.toFixed(1)} is above ${w.cores} cores: running on one tab until it settles`,
            );
          throttle.ms += w.ms;
          throttle.cores = w.cores;
        }),
    },
  };
}

/** Builds the fixtures in `root` (unless `--url` serves them) and lists them. */
export async function fixturePages(
  root: string,
  browser: BrowserConfig,
  flags: BrowserFlags,
): Promise<{ path: string; fixtures: string[] }> {
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
  return { path, fixtures };
}

/** Builds and serves the fixtures in `root`, unless `--url` points at a running server. */
async function withFixtures<T>(
  root: string,
  browser: BrowserConfig,
  flags: BrowserFlags,
  fn: (baseUrl: string, fixtures: string[]) => Promise<T>,
  swap?: { marker: string; css: string },
): Promise<T> {
  const { path, fixtures } = await fixturePages(root, browser, flags);
  if (flags.url) return fn(flags.url.replace(TRAILING_SLASH_RE, ""), fixtures);
  const { serveFixtures } = await import("../browser/serve");
  const server = serveFixtures(path, { swap });
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

/** A summary line's note of the time a run spent on one tab, if any. */
export const throttled = (t: { ms: number; cores: number }) =>
  t.ms ? ` (${seconds(t.ms)} on one tab: load above ${t.cores} cores)` : "";

/**
 * Names the pages that never matched `readySelector`, but those of
 * `allowNotReady` fixtures, on stderr; returns how many it named.
 */
export function reportNotReady(
  io: Io,
  labels: string[],
  pages: { readySelector?: string; allowNotReady?: string[] },
  anyway: string,
): number {
  const allowed = new Set(pages.allowNotReady);
  const late = labels.filter((l) => !allowed.has(l.split(" ")[0]));
  if (late.length)
    io.err(
      `crassus: ${plural(late.length, "page")} never matched readySelector ${JSON.stringify(pages.readySelector)} (${anyway} anyway): ${late.join(", ")}`,
    );
  return late.length;
}

/** The marked stylesheet's replacement, read from `file`. */
async function swapFrom(
  browser: BrowserConfig,
  flags: BrowserFlags,
  cwd: string,
  file: string,
) {
  const marker = needMarker(browser, "--css");
  if (flags.url) throw new UsageError("--css serves the fixtures: drop --url");
  const path = resolve(cwd, file);
  if (!existsSync(path)) throw new UsageError(`no such file: ${file}`);
  return { marker, css: await Bun.file(path).text() };
}

export function needMarker(browser: BrowserConfig, what: string): string {
  if (!browser.sheetMarker)
    throw new UsageError(
      `${what} needs \`browser.sheetMarker\`: text only the library stylesheet contains`,
    );
  return browser.sheetMarker;
}

/** `crassus capture <outDir> [--base <ref> | --css <file>]`. Exit 1 when a page never got ready. */
export async function captureCommand(opts: {
  config: Config;
  flags: BrowserFlags;
  outDir: string;
  base?: string;
  css?: string;
  io: Io;
}): Promise<number> {
  const { flags, io, base } = opts;
  const { cwd } = io;
  const { browser, states, pages, throttle } = settings(opts.config, flags, io);
  if (base && flags.url)
    throw new UsageError("--base builds its own fixtures: drop --url");
  if (base && opts.css)
    throw new UsageError(
      "--css swaps the stylesheet on today's fixtures; --base builds a ref's: pick one (or use crassus compare)",
    );
  const swap = opts.css
    ? await swapFrom(browser, flags, cwd, opts.css)
    : undefined;
  const outDir = resolve(cwd, opts.outDir);
  const { capture } = await import("../browser/snapshot");
  const run = (root: string) =>
    withFixtures(
      root,
      browser,
      flags,
      async (baseUrl, fixtures) => {
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
      },
      swap,
    );
  const { sha, result: r } = base
    ? await atRef(cwd, base, run)
    : { sha: "", result: await run(cwd) };
  const at = base
    ? ` at ${refLabel(base, sha)}`
    : opts.css
      ? ` with ${opts.css}`
      : "";
  io.out(
    `crassus: captured ${pagesLine(r.pages, r.fixtures, pages.themes.length, pages.viewports?.length ?? 1)}${at} into ${shownPath(cwd, outDir)} in ${seconds(r.ms)}${throttled(throttle)}`,
  );
  return reportNotReady(io, r.notReady, pages, "captured") ? 1 : 0;
}

/** Elements or pages on one side only: what cards don't cover. */
const domDiffers = (diff: SnapshotDiff) =>
  diff.pages.some((p) => p.removed.length > 0 || p.added.length > 0) ||
  diff.onlyBase.length > 0 ||
  diff.onlyHead.length > 0;

/**
 * Whether a comparison fails: with approvals, on a visible card none
 * covers (or a DOM difference); without, on any visible change.
 */
export const fails = (
  diff: SnapshotDiff,
  report: Report | undefined,
  approvals: Approvals | undefined,
) =>
  report && approvals
    ? blocking(report.cards).length > 0 || domDiffers(diff)
    : differs(diff);

/** Properties that stopped following a design token anywhere. */
const detached = (diff: SnapshotDiff) =>
  diff.pages.some((p) =>
    Object.values(p.tokens ?? {}).some((props) =>
      Object.values(props).some((t) => t.head.length === 0),
    ),
  );

// Properties one side didn't record, and changes no one can see, are listed
// for review, not failed on.
export const differs = (diff: SnapshotDiff) =>
  detached(diff) || diff.groups.some((g) => !g.invisible) || domDiffers(diff);

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
      e.message.replace(e.dir, shownPath(opts.io.cwd, e.dir)),
    );
  });
  await opts.summary?.(`crassus snapshot-diff ${opts.dirs.join(" ")}`, () =>
    formatSnapshotDiff(diff, "human"),
  );
  opts.io.out(formatSnapshotDiff(diff, opts.format));
  for (const side of ["base", "head"] as const) {
    const pages = diff.notReady?.[side] ?? [];
    if (pages.length)
      opts.io.err(
        `crassus: ${plural(pages.length, "page")} in ${side} (${shownPath(opts.io.cwd, side === "base" ? base : head)}) never matched readySelector when captured: ${pages.join(", ")}`,
      );
  }
  return differs(diff) ? 1 : 0;
}

/**
 * Points winners in the swapped library stylesheet at their source (through
 * each side's source map), or at least at the stylesheet they came from.
 */
function attribute(
  diff: SnapshotDiff,
  library: string,
  sides: { base: Sheet; head: Sheet },
) {
  const locate = {
    base: mappedLocator(sides.base),
    head: mappedLocator(sides.head),
  };
  for (const page of diff.pages)
    for (const props of Object.values(page.explain ?? {}))
      for (const explained of Object.values(props))
        for (const side of ["base", "head"] as const) {
          const w = explained[side];
          if (!w || w.sheet !== library) continue;
          const at = locate[side](
            w.line === undefined
              ? undefined
              : { line: w.line, column: w.column ?? 0 },
          );
          w.sheet = at?.file ?? sides[side].file ?? sides[side].name;
          if (at) {
            w.line = at.line;
            w.column = at.column;
          }
        }
}

/** The stylesheet the fixtures load, among the configured ones. */
export function pick<T extends { name: string }>(
  sheets: T[],
  entry: string[],
): T {
  if (entry.length > 1)
    throw new UsageError("compare swaps one stylesheet: give one --entry");
  const name = entry[0];
  const sheet = name
    ? sheets.find((s) => s.name === name)
    : sheets.length === 1
      ? sheets[0]
      : undefined;
  if (!sheet)
    throw new UsageError(
      name
        ? `no stylesheet named ${name} (${sheets.map((s) => s.name).join(", ")})`
        : `pick the stylesheet the fixtures load with --entry (${sheets.map((s) => s.name).join(", ")})`,
    );
  return sheet;
}

/** One line on what a change can reach, before its pages are captured. */
function impactLine(impact: Impact): string {
  if (impact.unchanged)
    return "no rule differs between the stylesheets: nothing to compare (no page was loaded, so none was checked for readySelector)";
  if (impact.everything)
    return `every page and element is read: ${impact.everything}`;
  const index =
    impact.index === "built"
      ? `; page index built${impact.indexWhy ? ` (${impact.indexWhy})` : ""}`
      : "; page index cached";
  return `the changed rules (${plural(impact.selectors, "selector")}) reach ${impact.pages} of ${plural(impact.total, "page")} (${plural(impact.elements, "element")}, with their descendants)${index}`;
}

/** What `compare` and `bisect` share: checks first, then a run per stylesheet pair. */
export function comparer(opts: {
  config: Config;
  flags: BrowserFlags;
  cwd: string;
  explain?: boolean;
  visual?: boolean;
  /** Default true. */
  scope?: boolean;
  /** Keep what change cards need (markup, crops). */
  report?: boolean;
  io?: Io;
}) {
  const { flags, cwd } = opts;
  const { browser, states, pages, tokens, throttle } = settings(
    opts.config,
    flags,
    opts.io,
  );
  const marker = needMarker(browser, "compare");
  if (flags.url)
    throw new UsageError("compare serves the fixtures twice: drop --url");
  if ((opts.explain || opts.visual) && pages.engine !== "chrome")
    throw new UsageError("--explain and --visual need --engine chrome");
  // Today's fixtures, built once, on the first run.
  let built: Promise<{ path: string; fixtures: string[] }> | undefined;
  return {
    pages,
    throttle,
    /** `pages × fixtures × themes × viewports`, for a summary line. */
    describe: (n: number, fixtures: number) =>
      pagesLine(n, fixtures, pages.themes.length, pages.viewports?.length ?? 1),
    async run(
      sides: { base: Sheet; head: Sheet },
      onImpact?: (impact: Impact) => void,
      /** Only these fixtures (by name). */
      only?: string[],
    ) {
      // Nothing to load, nor fixtures to build, when no rule differs.
      if (
        opts.scope !== false &&
        nothingChanged(changedRules(sides.base.css, sides.head.css))
      ) {
        const impact: Impact = {
          unchanged: true,
          total: 0,
          pages: 0,
          elements: 0,
          selectors: 0,
        };
        onImpact?.(impact);
        const { summarizePages } = await import("../browser/snapshot-diff");
        const result = { ...summarizePages([], [], []), impact };
        return { result, ms: 0, notReady: [], crops: undefined, fixtures: 0 };
      }
      built ??= fixturePages(cwd, browser, flags);
      const { path, fixtures: all } = await built;
      const fixtures = only ? all.filter((f) => only.includes(f)) : all;
      const { compareCss } = await import("../browser/compare");
      const diff = await compareCss({
        ...pages,
        dir: path,
        fixtures,
        sheetMarker: marker,
        base: sides.base.css,
        head: sides.head.css,
        states: states
          ? pages.engine === "chrome"
            ? "cdp"
            : "rewrite"
          : false,
        emulate: EMULATE[pages.engine],
        settleMs: browser.settleMs,
        explain: opts.explain,
        visual: opts.visual,
        scope: opts.scope,
        indexDir: cacheDir(cwd),
        onImpact,
        report: opts.report,
        tokens,
      });
      if (opts.explain) attribute(diff, diff.library, sides);
      const { ms, notReady, library: _, crops, ...result } = diff;
      return { result, ms, notReady, crops, fixtures: fixtures.length };
    },
  };
}

/**
 * `crassus compare [--base <ref>] | <base.css> <head.css>`: today's fixtures
 * with each side's library stylesheet, diffed page by page. Exit 1 when
 * anything visible differs or a page never got ready.
 */
export async function compareCommand(opts: {
  config: Config;
  configFile?: string;
  flags: BrowserFlags;
  files: string[];
  base?: string;
  entry: string[];
  cache: boolean;
  explain?: boolean;
  visual?: boolean;
  scope?: boolean;
  format: CompareFormat;
  /** Write change cards to this directory. */
  report?: string;
  io: Io;
  summary?: Summary;
}): Promise<number> {
  const { io, files } = opts;
  const { cwd } = io;
  const { approvals, cards, cmp } = await cardComparer({ ...opts, cwd });
  let baseSha: string | undefined;
  let entry: string | undefined;
  let label: string;
  let sides: { base: Sheet; head: Sheet };
  if (files.length > 0) {
    if (files.length !== 2 || opts.base)
      throw new UsageError(
        "compare takes two CSS files (base, head), or --base <ref> with the config",
      );
    const [base, head] = await filesAsSheets(cwd, files);
    sides = { base, head };
    label = files[0];
  } else {
    const ref = opts.base ?? "HEAD";
    const sheet = pick(
      await stylesheets(cwd, opts.config, opts.entry),
      opts.entry,
    );
    const started = performance.now();
    const b = await baseStylesheets({
      cwd,
      ref,
      config: opts.config,
      configText: opts.configFile ? await Bun.file(opts.configFile).text() : "",
      only: [sheet.name],
      cache: opts.cache,
    });
    sides = { base: pick(b.sheets, [sheet.name]), head: sheet };
    label = `${sheet.name} at ${refLabel(ref, b.sha)}`;
    baseSha = b.sha;
    entry = sheet.name;
    if (opts.format === "human")
      io.err(
        `crassus: base ${refLabel(ref, b.sha)} ${b.cached ? "from cache" : `built in ${seconds(performance.now() - started)}`}`,
      );
  }
  const { result, ms, notReady, crops, fixtures } = await cmp.run(
    sides,
    (impact) =>
      opts.format === "human" &&
      opts.scope !== false &&
      io.err(`crassus: ${impactLine(impact)}`),
  );
  const text = (format: "human" | "json") =>
    formatSnapshotDiff(result, format, "compare");
  if (result.impact?.unchanged) {
    if (opts.format !== "human")
      io.out(cardsOrText(undefined, { ...opts, cwd }, text));
    return 0;
  }
  if (opts.format === "human")
    io.err(
      `crassus: compared ${cmp.describe(result.files, fixtures)} against ${label} in ${seconds(ms)}${throttled(cmp.throttle)}`,
    );
  await opts.summary?.(`crassus compare against ${label}`, () => text("human"));
  const report = cards
    ? await changeCards({
        runs: [{ pages: result.pages, crops }],
        command: "compare",
        base: label,
        head: files[1] ?? "the working tree",
        cwd,
        shas: () => ({ base: baseSha }),
        css: { base: sides.base.css, head: sides.head.css },
        dir: opts.report,
        approvals,
        inputs: {
          entry,
          base: files[0] ?? opts.base ?? "HEAD",
          ...(files[1] && { head: files[1] }),
          themes: cmp.pages.themes,
          viewports: cmp.pages.viewports,
          flags: opts.flags,
        },
      })
    : undefined;
  io.out(cardsOrText(report, { ...opts, cwd }, text));
  // Without a report, still the cards' counts: what they'd be.
  if (!report && opts.format === "human")
    io.out(`\n${formatCardsBrief(buildCards([{ pages: result.pages }]))}`);
  const late = reportNotReady(io, notReady, cmp.pages, "compared");
  return fails(result, report, approvals) || late ? 1 : 0;
}

export const COMPARE_FORMATS = ["human", "json", "markdown", "sarif"] as const;
export type CompareFormat = (typeof COMPARE_FORMATS)[number];

/** Cards come with `--report`, Markdown and SARIF: they need the winners. */
const cardsWanted = (o: { report?: string; format: CompareFormat }) =>
  Boolean(o.report) || o.format === "markdown" || o.format === "sarif";

/** `comparer` for compare and bisect, keeping what their change cards need. */
export async function cardComparer(
  opts: Omit<Parameters<typeof comparer>[0], "report"> & {
    report?: string;
    format: CompareFormat;
  },
) {
  const approvals = await readApprovals(opts.cwd);
  // Approvals are by card: they need the winners.
  const cards = cardsWanted(opts) || Boolean(approvals);
  const cmp = comparer({
    ...opts,
    explain: opts.explain || cards,
    visual: opts.visual || Boolean(opts.report),
    report: Boolean(opts.report),
  });
  return { approvals, cards, cmp };
}

/**
 * What compare and bisect print: the cards as Markdown or SARIF, else
 * `text` as human or json, then the cards' summary when `summary`.
 */
export function cardsOrText(
  report: Report | undefined,
  o: { format: CompareFormat; report?: string; cwd: string },
  text: (format: "human" | "json") => string,
  summary = Boolean(report),
): string {
  if (report && (o.format === "markdown" || o.format === "sarif"))
    return o.format === "markdown"
      ? formatCardsMarkdown(report)
      : formatCardsSarif(report);
  // JSON stays one document: the cards' counts and what fails go in it.
  if (o.format === "json")
    return report
      ? JSON.stringify(
          {
            ...JSON.parse(text("json")),
            cards: {
              summary: report.summary,
              failing: blocking(report.cards).map((c) => c.id),
            },
          },
          null,
          2,
        )
      : text("json");
  const dir = o.report && shownPath(o.cwd, resolve(o.cwd, o.report));
  return (
    text("human") +
    (report && summary ? `\n\n${formatCardsSummary(report, dir)}` : "")
  );
}

/** Builds a run's change cards, reads their sources, and writes the report directory. */
export async function changeCards(o: {
  runs: {
    pages: Parameters<typeof buildCards>[0][number]["pages"];
    crops?: Crops;
    commits?: { sha: string; subject: string }[];
    commit?: string;
  }[];
  command: Report["command"];
  base: string;
  head: string;
  cwd: string;
  shas: (card: Card) => { base?: string; head?: string };
  css: { base: string; head: string };
  dir?: string;
  approvals?: Approvals;
  inputs: object;
}): Promise<Report> {
  const report = buildReport(
    o.command,
    o.base,
    o.head,
    buildCards(o.runs),
    o.approvals,
  );
  await attachSources(report, { cwd: o.cwd, shas: o.shas });
  if (o.dir)
    await writeReport(resolve(o.cwd, o.dir), report, {
      crops: new Map(o.runs.map((r) => [r.commit ?? "", r.crops ?? {}])),
      base: o.css.base,
      head: o.css.head,
      inputs: { command: o.command, ...o.inputs },
      label: shownPath(o.cwd, resolve(o.cwd, o.dir)),
    });
  return report;
}

/**
 * `crassus tokens`: which design tokens drive which properties on the
 * fixtures, unused tokens and hard-coded colors. Always exit 0: evidence.
 */
export async function tokensCommand(opts: {
  config: Config;
  flags: BrowserFlags;
  format: "human" | "json";
  io: Io;
}): Promise<number> {
  const { flags, io } = opts;
  const { browser, pages, tokens, throttle } = settings(opts.config, flags, io);
  if (!tokens)
    throw new UsageError(
      "tokens needs a prefix: --tokens cds- (for --cds-*) or `browser.tokens` in crassus.config.ts",
    );
  const { traceTokens } = await import("../browser/tokens");
  const r = await withFixtures(io.cwd, browser, flags, (baseUrl, fixtures) =>
    traceTokens({
      ...pages,
      baseUrl,
      fixtures,
      emulate: EMULATE[pages.engine],
      settleMs: browser.settleMs,
      prefix: tokens,
    }),
  );
  if (opts.format === "json") {
    io.out(
      JSON.stringify(
        {
          schema: 1,
          command: "tokens",
          claim: "evidence",
          prefix: tokens,
          ...r,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const used = Object.entries(r.used).sort(
    (a, b) => b[1].elements - a[1].elements,
  );
  const top = (props: Record<string, number>) =>
    Object.entries(props)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([p, n]) => `${p} ${n}`)
      .join(", ");
  io.out(
    [
      `crassus: ${r.traced} ${tokens}* token(s) traced over ${plural(r.pages, "page")} in ${seconds(r.ms)}${throttled(throttle)}: ${used.length} followed, ${r.unused.length} unused (evidence, bounded by the fixtures)`,
      "",
      "Most followed:",
      ...used
        .slice(0, 15)
        .map(
          ([name, u]) =>
            `  ${name}  ${u.elements} element(s) on ${u.pages.length} page(s): ${top(u.properties)}`,
        ),
      ...(r.unused.length
        ? [
            "",
            `Unused on the fixtures: ${r.unused.slice(0, 30).join(", ")}${r.unused.length > 30 ? `, and ${r.unused.length - 30} more (--format json lists them)` : ""}`,
          ]
        : []),
      ...colorList(
        "Hard-coded: colors an author rule sets as a literal, following no token, most common first:",
        r.hardCoded,
        r.omitted.hardCoded,
      ),
      ...colorList(
        "User agent defaults: colors no author rule sets (on a themed element, a missed token), most common first:",
        r.uaDefaults,
        r.omitted.uaDefaults,
      ),
    ].join("\n"),
  );
  reportNotReady(io, r.notReady, pages, "traced");
  return 0;
}

type Omitted = TokenReport["omitted"]["hardCoded"];

const leftOut = (o: Omitted | undefined) =>
  [
    o?.invisible && `+${o.invisible} on elements no one can see`,
    o?.inherited &&
      `+${o.inherited} inherited with the same value, counted where it's set`,
  ]
    .filter(Boolean)
    .join("; ");

const colorList = (
  heading: string,
  list: TokenReport["hardCoded"],
  omitted: Omitted,
) => {
  const total = leftOut(omitted);
  return list.length || total
    ? [
        "",
        heading,
        ...list.slice(0, 15).map((h) => {
          const out = leftOut(h.omitted);
          return `  ${h.count}×  ${h.property}: ${h.value}${out ? ` (${out})` : ""}  e.g. ${h.examples[0].page}  ${h.examples[0].path}`;
        }),
        ...(total ? [`  (left out of this list: ${total})`] : []),
      ]
    : [];
};

/** `crassus usage`: writes usage.json and report.md. Always exit 0: evidence, not proof. */
export async function usageCommand(opts: {
  config: Config;
  flags: BrowserFlags;
  outDir?: string;
  io: Io;
}): Promise<number> {
  const { flags, io } = opts;
  const { cwd } = io;
  const { browser, states, pages, throttle } = settings(opts.config, flags, io);
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
  const where = shownPath(cwd, outDir);
  io.out(
    [
      `crassus: usage over ${pagesLine(summary.fixtures * summary.themes * summary.viewports, summary.fixtures, summary.themes, summary.viewports)} in ${seconds(r.ms)}${throttled(throttle)} (evidence, bounded by the fixtures)`,
      `  ${summary.declarationsNeverWon} of ${summary.declarationsTotal} matched declarations never won (${usage.fold} fold candidates); ${usage.unmatched.length} rules never matched`,
      `  ${join(where, "usage.json")}, ${join(where, "report.md")}`,
    ].join("\n"),
  );
  reportNotReady(io, r.notReady, pages, "read");
  return 0;
}

/**
 * `diff --confirm`: renders each cascade flip in Chrome, on a fixture page
 * with an element both rules match (from the page index) or on one built
 * for it, and records whether the property's value changes. Flips no
 * fixture combination allows are dropped as never seen.
 */
export async function confirmDiff(opts: {
  results: DiffResult[];
  base: Sheet[];
  head: Sheet[];
  config: Config;
  flags: BrowserFlags;
  cwd: string;
  io?: Io;
}): Promise<void> {
  const { browser, pages } = settings(opts.config, opts.flags, opts.io);
  const marker = needMarker(browser, "--confirm");
  const { path, fixtures } = await fixturePages(opts.cwd, browser, opts.flags);
  const { pageIndex } = await import("../browser/page-index");
  const { confirmFlips } = await import("../browser/flips");
  const { index } = await pageIndex({
    ...pages,
    dir: path,
    fixtures,
    sheetMarker: marker,
    emulate: EMULATE[pages.engine],
    settleMs: browser.settleMs,
    cacheDir: cacheDir(opts.cwd),
  });
  for (const r of opts.results) {
    const flips = [...r.flips, ...r.moveFlips];
    const base = opts.base.find((s) => s.name === r.entry);
    const head = opts.head.find((s) => s.name === r.entry);
    if (!flips.length || !base || !head) continue;
    // biome-ignore lint/performance/noAwaitInLoops: one browser at a time
    const verdicts = await confirmFlips({
      flips: flips.map((f) => ({
        selectors: [f.rule.selector, f.other.selector],
        property: f.property,
      })),
      base: base.css,
      head: head.css,
      index,
      engine: pages.engine,
      chromePath: pages.chromePath,
    });
    flips.forEach((f, i) => {
      f.confirmed = verdicts[i];
    });
  }
}
