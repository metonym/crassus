import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { version } from "../../package.json";
import { baseStylesheets } from "./baseline";
import {
  type BrowserFlags,
  captureCommand,
  compareCommand,
  snapshotDiffCommand,
  usageCommand,
} from "./browser";
import { runDead, runDiff } from "./commands";
import { FixCheckError, fix } from "./fix";
import {
  filesAsSheets,
  fixStylesheets,
  isOneOf,
  loadConfig,
  stylesheets,
  UsageError,
} from "./project";
import {
  appendSummary,
  FORMATS,
  formatDead,
  formatDiff,
  formatFix,
  refLabel,
  type Summary,
  seconds,
  uncolored,
} from "./report";
import type { Sheet } from "./sources";

const HELP = `crassus ${version}: CSS cascade regression testing

Usage:
  crassus dead [file.css...]     declarations that can never win (proof)
  crassus dead --fix             delete them (in the CSS, or in its sources)
  crassus diff [--base <ref>]    cascade flips since a git ref (heuristic)
  crassus diff <base.css> <head.css>
  crassus capture <outDir>       computed styles of every fixture page
  crassus capture --base <ref> <outDir>
  crassus capture --css <file> <outDir>
  crassus snapshot-diff <baseDir> <headDir>
                                 compare two captures (ground truth)
  crassus compare [--base <ref>] today's fixtures with the library
                                 stylesheet at a ref and now, diffed page
                                 by page; no snapshots kept (ground truth)
  crassus compare <base.css> <head.css>
  crassus usage                  declarations that match but never win on
                                 the fixtures (evidence)

Stylesheets come from the files given, or from crassus.config.ts: \`css\`
(with an optional \`build\` command) or a \`compile(root)\` hook. Source maps
attribute findings to their sources. Fixture pages for capture and usage come
from its \`browser\` block.

Options:
  --base <ref>       git ref to diff against (default: HEAD); built in a
                     temporary worktree and cached by commit
  --entry <name>     only this stylesheet (repeatable)
  --format <format>  human (default), json, github, sarif
  --json             same as --format json
  --config <file>    config file (default: crassus.config.{ts,js,mjs})
  --fix              dead: delete dead declarations. CSS without a source
                     map is edited in place; with one, a source declaration
                     goes when everything it produces is dead. Checked by
                     re-analyzing; undone if more than that changed.
  --dry-run          with --fix: print the edits as a patch, write nothing
  --no-cache         rebuild the base
  --verbose          show every rule in review sections
  --summary <file>   dead, diff, snapshot-diff, compare: also append the human report
                     to this file ($GITHUB_STEP_SUMMARY), whatever --format

Browser options (capture, compare, usage; override the config's \`browser\`):
  --only <text>      only fixtures whose name contains this
  --themes <a,b>     themes to load each page in
  --viewport <WxH>   viewport (repeatable)
  --no-states        skip forced :hover/:focus/:active states
  --engine <name>    chrome (default) or webkit
  --matcher <name>   usage: dom (default, any engine) or cdp (Chrome)
  --concurrency <n>  tabs in parallel (default: half the cores, at most 4)
  --css <file>       capture: serve this CSS in place of the stylesheet that
                     contains \`browser.sheetMarker\`
  --url <base>       use a running server instead of building and serving
  --out <dir>        usage: output directory (default .crassus/usage)
  -h, --help         show this help
  -v, --version      show the version

Exit codes: 0 clean, 1 findings (snapshot-diff: any difference; capture: a
page never matched readySelector), 2 usage error. usage always exits 0.`;

const SYSTEM_ERROR_RE = /^E[A-Z]+$/;

/** A Sass/Less partial: imported by entries, never compiled alone. */
const PARTIAL_RE = /(?:^|\/)_[^/]+\.(?:scss|sass|less)$/;

export interface Io {
  cwd: string;
  out: (text: string) => void;
  err: (text: string) => void;
}

const defaultIo: Io = {
  cwd: process.cwd(),
  out: (t) => process.stdout.write(`${t}\n`),
  err: (t) => process.stderr.write(`${t}\n`),
};

export async function main(
  argv: string[],
  io: Io = defaultIo,
): Promise<number> {
  try {
    return await run(argv, io);
  } catch (e) {
    const err = e as Error & { code?: string; path?: string };
    const expected =
      e instanceof UsageError ||
      e instanceof FixCheckError ||
      err.code?.startsWith("ERR_PARSE_ARGS");
    // A system error (ENOSPC, EACCES) is about the machine, not crassus.
    const system =
      typeof err.code === "string" && SYSTEM_ERROR_RE.test(err.code);
    const where =
      system && err.path && !err.message.includes(err.path)
        ? ` (${err.path})`
        : "";
    io.err(
      `crassus: ${expected || system ? err.message + where : (err.stack ?? e)}`,
    );
    return 2;
  }
}

async function run(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      base: { type: "string" },
      entry: { type: "string", multiple: true },
      format: { type: "string" },
      json: { type: "boolean" },
      config: { type: "string" },
      "no-cache": { type: "boolean" },
      fix: { type: "boolean" },
      "dry-run": { type: "boolean" },
      verbose: { type: "boolean" },
      only: { type: "string" },
      themes: { type: "string" },
      viewport: { type: "string", multiple: true },
      "no-states": { type: "boolean" },
      engine: { type: "string" },
      matcher: { type: "string" },
      concurrency: { type: "string" },
      url: { type: "string" },
      css: { type: "string" },
      out: { type: "string" },
      summary: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.version) {
    io.out(version);
    return 0;
  }
  const [command, ...files] = positionals;
  if (values.help || !command) {
    io.out(HELP);
    return values.help ? 0 : 2;
  }
  const format = values.json ? "json" : (values.format ?? "human");
  if (!isOneOf(FORMATS, format))
    throw new UsageError(
      `unknown format ${format} (one of ${FORMATS.join(", ")})`,
    );
  const only = values.entry ?? [];
  const verbose = values.verbose ?? false;
  const { cwd } = io;

  if (values["dry-run"] && !values.fix)
    throw new UsageError("--dry-run goes with --fix");
  const summaryFile = values.summary;
  const summary: Summary | undefined = summaryFile
    ? (title, report) =>
        appendSummary(resolve(cwd, summaryFile), title, uncolored(report))
    : undefined;
  if (summary && (values.fix || command === "capture" || command === "usage"))
    throw new UsageError(
      "--summary goes with dead, diff, snapshot-diff and compare",
    );
  if (values.css && command !== "capture")
    throw new UsageError("--css goes with capture");
  if (command === "dead") {
    const { config } = await loadConfig(cwd, values.config);
    const load = () =>
      files.length > 0
        ? filesAsSheets(cwd, files)
        : values.fix
          ? fixStylesheets(cwd, config)
          : stylesheets(cwd, config, only);
    const sheets = await load();
    const results = runDead(sheets);
    if (!values.fix) {
      await summary?.("crassus dead", () => formatDead(results, "human"));
      io.out(formatDead(results, format));
      return results.some((r) => r.dead.length > 0) ? 1 : 0;
    }
    if (format !== "human" && format !== "json")
      throw new UsageError("--fix reports as human or json");
    if (only.length > 0 && files.length === 0)
      throw new UsageError(
        "--fix needs every stylesheet that may share sources: drop --entry",
      );
    const report = await fix({
      sheets,
      results,
      root: cwd,
      generated: files.length === 0 && Boolean(config.build) && !config.compile,
      dryRun: values["dry-run"] ?? false,
      // CSS files given on the command line can't be rebuilt from sources.
      reload: files.length > 0 ? null : load,
    });
    io.out(formatFix(report, results, format));
    const partials = [
      ...new Set(
        report.fixed.map((f) => f.file).filter((f) => PARTIAL_RE.test(f)),
      ),
    ];
    if (partials.length > 0 && !config.fixEntries && files.length === 0)
      io.err(
        `crassus: ${partials.join(", ")} ${partials.length === 1 ? "is a partial" : "are partials"}: the fix is proved for ${sheets.map((s) => s.name).join(", ")} only. If other entries import it, list them in \`fixEntries\`.`,
      );
    return report.skipped.length > 0 ? 1 : 0;
  }
  if (values.fix) throw new UsageError("--fix goes with dead");

  if (command === "diff") {
    const { config, file } = await loadConfig(cwd, values.config);
    let base: { ref: string; sha: string };
    let baseSheets: Sheet[];
    let headSheets: Sheet[];
    if (files.length > 0) {
      if (files.length !== 2 || values.base)
        throw new UsageError(
          "diff takes two files (base, head), or --base <ref> with the config",
        );
      [baseSheets, headSheets] = await Promise.all([
        filesAsSheets(cwd, [files[0]]),
        filesAsSheets(cwd, [files[1]]),
      ]);
      // Compare the two files as one entry.
      headSheets[0].name = baseSheets[0].name;
      base = { ref: files[0], sha: "" };
    } else {
      const ref = values.base ?? "HEAD";
      const started = performance.now();
      const [b, head] = await Promise.all([
        baseStylesheets({
          cwd,
          ref,
          config,
          configText: file ? await Bun.file(file).text() : "",
          only,
          cache: !values["no-cache"],
        }),
        stylesheets(cwd, config, only),
      ]);
      if (format === "human")
        io.err(
          `crassus: base ${refLabel(ref, b.sha)} ${b.cached ? "from cache" : `built in ${seconds(performance.now() - started)}`}`,
        );
      base = { ref, sha: b.sha };
      baseSheets = b.sheets;
      headSheets = head;
    }
    const { results, onlyBase, onlyHead } = await runDiff(
      baseSheets,
      headSheets,
      config,
    );
    for (const name of onlyBase)
      io.err(`crassus: ${name} is only in the base; skipped`);
    for (const name of onlyHead)
      io.err(`crassus: ${name} is only in the head; skipped`);
    await summary?.(`crassus diff against ${base.ref}`, () =>
      formatDiff(results, base, "human", verbose),
    );
    io.out(formatDiff(results, base, format, verbose));
    return results.some((r) => r.flips.length > 0) ? 1 : 0;
  }

  const flags: BrowserFlags = {
    only: values.only,
    themes: values.themes,
    viewport: values.viewport,
    noStates: values["no-states"],
    engine: values.engine,
    matcher: values.matcher,
    concurrency: values.concurrency,
    url: values.url,
  };
  if (command === "snapshot-diff") {
    if (format !== "human" && format !== "json")
      throw new UsageError("snapshot-diff reports as human or json");
    return snapshotDiffCommand({ dirs: files, format, io, summary });
  }
  if (command === "compare") {
    if (format !== "human" && format !== "json")
      throw new UsageError("compare reports as human or json");
    const { config, file } = await loadConfig(cwd, values.config);
    return compareCommand({
      config,
      configFile: file,
      flags,
      files,
      base: values.base,
      entry: only,
      cache: !values["no-cache"],
      format,
      io,
      summary,
    });
  }
  if (command === "capture" || command === "usage") {
    if (format !== "human")
      throw new UsageError(`${command} writes files; drop --format`);
    const { config } = await loadConfig(cwd, values.config);
    if (command === "usage") {
      if (files.length > 0)
        throw new UsageError(
          "usage takes no files (fixtures come from the config)",
        );
      return usageCommand({ config, flags, outDir: values.out, io });
    }
    const outDir = files[0] ?? values.out;
    if (!outDir || files.length > 1 || (files[0] && values.out))
      throw new UsageError("capture takes one output directory");
    return captureCommand({
      config,
      flags,
      outDir,
      base: values.base,
      css: values.css,
      io,
    });
  }

  throw new UsageError(`unknown command ${command} (run crassus --help)`);
}
