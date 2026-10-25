import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { version } from "../../package.json";
import { baseStylesheets, headStylesheets } from "./baseline";
import { bisectCommand } from "./bisect";
import {
  type BrowserFlags,
  COMPARE_FORMATS,
  captureCommand,
  compareCommand,
  confirmDiff,
  snapshotDiffCommand,
  tokensCommand,
  usageCommand,
} from "./browser";
import {
  approveCommand,
  explainCommand,
  reduceCommand,
  reproCommand,
  verifyCommand,
} from "./card-commands";
import { DEFAULT_DIR } from "./cards";
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
  crassus bisect <from>..<to>    the commits in a range that changed computed
                                 styles on today's fixtures (ground truth)
  crassus usage                  declarations that match but never win on
                                 the fixtures (evidence)
  crassus coverage               mutation coverage: which declarations decide
                                 a value the fixtures render (evidence)
  crassus doctor                 check Chrome, the machine and the config
                                 before a long browser run
  crassus tokens --tokens cds-   which design tokens drive which properties
                                 on the fixtures; unused tokens; hard-coded
                                 colors (evidence)
  crassus explain <id>           one change card from a report, as Markdown
                                 (or --format json)
  crassus repro <id>             a standalone page that shows the card's
                                 element under each side's rules
  crassus verify <id>            whether the card's elements match base
                                 again with the stylesheet now
  crassus reduce <id>            the fewest declaration edits of the change
                                 that still give the card's element its
                                 head value (delta debugging)
  crassus approve <id...>        record cards as intended changes in
                                 crassus.approved.json: compare and bisect
                                 then fail only on visible cards it lacks

Stylesheets come from the files given, or from crassus.config.ts: \`css\`
(with an optional \`build\` command) or a \`compile(root)\` hook. Source maps
attribute findings to their sources. Fixture pages for capture and usage come
from its \`browser\` block.

Options:
  --base <ref>       git ref to diff against (default: HEAD); built in a
                     temporary worktree and cached by commit, or, with the
                     config's \`inputs\`, from just those paths and cached
                     by their contents
  --entry <name>     only this stylesheet (repeatable)
  --format <format>  human (default), json, github, sarif; compare and
                     bisect: human, json, markdown or sarif (change cards)
  --json             same as --format json
  --config <file>    config file (default: crassus.config.{ts,js,mjs})
  --fix              dead: delete dead declarations. CSS without a source
                     map is edited in place; with one, a source declaration
                     goes when everything it produces is dead. Checked by
                     re-analyzing; undone if more than that changed.
  --dry-run          with --fix: print the edits as a patch, write nothing
  --no-cache         rebuild the base
  --verbose          show every rule in review sections
  --summary <file>   dead, diff, snapshot-diff, compare, bisect: also append the human report
                     to this file ($GITHUB_STEP_SUMMARY), whatever --format

Browser options (capture, compare, bisect, usage; override the config's \`browser\`):
  --only <text>      only fixtures whose name contains this
  --themes <a,b>     themes to load each page in
  --viewport <WxH>   viewport (repeatable)
  --no-states        skip forced :hover/:focus/:active states
  --engine <name>    chrome (default) or webkit
  --matcher <name>   usage: dom (default, any engine) or cdp (Chrome)
  --concurrency <n>  tabs in parallel (default: half the cores, at most 4)
  --css <file>       capture: serve this CSS in place of the stylesheet that
                     contains \`browser.sheetMarker\`
  --explain          compare, bisect: the rule that won each changed property,
                     on each side, for the example elements (Chrome)
  --visual           compare, bisect: screenshot each changed element on both
                     sides and count those whose pixels differ (Chrome)
  --group-by <how>   bisect: segments of consecutive commits of one
                     conventional type (type, default) or one per commit
  --no-split         bisect: report segments with visible changes as they
                     are, instead of halving them down to the commits
  --confirm          diff: render each cascade flip in Chrome (a fixture
                     page with an element both rules match, or one built
                     for it) and fail only on those whose value changes;
                     drop combinations no fixture renders
  --no-scope         compare, bisect: load every page and read every element,
                     instead of only what the changed rules can reach
  --tokens <prefix>  compare, bisect: trace which properties follow design
                     tokens (custom properties with this prefix: cds- for
                     --cds-*),
                     and fail where one stops following them; tokens: the
                     prefix to report on (default: the config's
                     browser.tokens)
  --property <name>  reduce: the property to reproduce (default: the card's
                     most frequent change)
  --report <dir>     compare, bisect: write change cards (report.json,
                     index.html, report.md, crops) to this directory, with
                     --explain and --visual; explain, repro, verify: read it
                     (default ${DEFAULT_DIR})
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
      explain: { type: "boolean" },
      "group-by": { type: "string" },
      "no-split": { type: "boolean" },
      "no-scope": { type: "boolean" },
      confirm: { type: "boolean" },
      report: { type: "string" },
      tokens: { type: "string" },
      property: { type: "string" },
      visual: { type: "boolean" },
      out: { type: "string" },
      summary: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const flags: BrowserFlags = {
    only: values.only,
    themes: values.themes,
    viewport: values.viewport,
    noStates: values["no-states"],
    engine: values.engine,
    matcher: values.matcher,
    concurrency: values.concurrency,
    url: values.url,
    tokens: values.tokens,
  };
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
  const cardCommand = command === "compare" || command === "bisect";
  if (
    cardCommand ? !isOneOf(COMPARE_FORMATS, format) : !isOneOf(FORMATS, format)
  )
    throw new UsageError(
      `unknown format ${format} (one of ${(cardCommand ? COMPARE_FORMATS : FORMATS).join(", ")})`,
    );
  // Checked above: what dead and diff take.
  const coreFormat = isOneOf(FORMATS, format) ? format : "human";
  if (
    values.report !== undefined &&
    !cardCommand &&
    !["explain", "repro", "verify", "approve", "reduce"].includes(command)
  )
    throw new UsageError(
      "--report goes with compare, bisect, explain, repro, verify, approve and reduce",
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
      "--summary goes with dead, diff, snapshot-diff, compare and bisect",
    );
  if (values.confirm && command !== "diff")
    throw new UsageError("--confirm goes with diff");
  if (values.css && command !== "capture")
    throw new UsageError("--css goes with capture");
  if (
    (values.explain || values.visual) &&
    command !== "compare" &&
    command !== "bisect"
  )
    throw new UsageError(
      command === "snapshot-diff"
        ? "--explain and --visual reopen both sides of a page, which a capture directory can't: use crassus compare"
        : "--explain and --visual go with compare and bisect",
    );
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
      io.out(formatDead(results, coreFormat));
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
      const side = {
        cwd,
        config,
        configText: file ? await Bun.file(file).text() : "",
        only,
        cache: !values["no-cache"],
      };
      const [b, head] = await Promise.all([
        baseStylesheets({ ...side, ref }),
        headStylesheets(side),
      ]);
      if (format === "human")
        io.err(
          `crassus: base ${refLabel(ref, b.sha)} ${b.cached ? "from cache" : `built in ${seconds(performance.now() - started)}`}`,
        );
      base = { ref, sha: b.sha };
      baseSheets = b.sheets;
      headSheets = head.sheets;
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
    if (values.confirm)
      await confirmDiff({
        results,
        base: baseSheets,
        head: headSheets,
        config,
        flags,
        cwd,
        io,
      });
    await summary?.(`crassus diff against ${base.ref}`, () =>
      formatDiff(results, base, "human", verbose),
    );
    io.out(formatDiff(results, base, coreFormat, verbose));
    // Confirmed, only what Chrome shows changing fails.
    return results.some((r) =>
      r.flips.some(
        (f) => !values.confirm || f.confirmed?.verdict === "confirmed",
      ),
    )
      ? 1
      : 0;
  }

  if (command === "snapshot-diff") {
    if (format !== "human" && format !== "json")
      throw new UsageError("snapshot-diff reports as human or json");
    return snapshotDiffCommand({ dirs: files, format, io, summary });
  }
  if ((values["group-by"] || values["no-split"]) && command !== "bisect")
    throw new UsageError("--group-by and --no-split go with bisect");
  if (values["no-scope"] && command !== "compare" && command !== "bisect")
    throw new UsageError("--no-scope goes with compare and bisect");
  if (command === "approve")
    return approveCommand({ ids: files, report: values.report, io });
  if (command === "explain") {
    if (format !== "human" && format !== "json")
      throw new UsageError("explain prints human (Markdown) or json");
    return explainCommand({ ids: files, report: values.report, format, io });
  }
  if (command === "reduce") {
    if (format !== "human" && format !== "json")
      throw new UsageError("reduce reports as human or json");
    const { config } = await loadConfig(cwd, values.config);
    return reduceCommand({
      ids: files,
      report: values.report,
      property: values.property,
      config,
      format,
      io,
    });
  }
  if (command === "repro" || command === "verify") {
    const { config } = await loadConfig(cwd, values.config);
    return command === "repro"
      ? reproCommand({ ids: files, report: values.report, config, io })
      : verifyCommand({
          ids: files,
          report: values.report,
          config,
          entry: only,
          io,
        });
  }
  if (command === "bisect") {
    if (!isOneOf(COMPARE_FORMATS, format))
      throw new UsageError("bisect reports as human, json, markdown or sarif");
    const { config, file } = await loadConfig(cwd, values.config);
    return bisectCommand({
      config,
      configFile: file,
      flags,
      range: files,
      groupBy: values["group-by"] ?? "type",
      split: !values["no-split"],
      entry: only,
      cache: !values["no-cache"],
      explain: values.explain,
      visual: values.visual,
      scope: !values["no-scope"],
      format,
      report: values.report,
      io,
      summary,
    });
  }
  if (command === "compare") {
    if (!isOneOf(COMPARE_FORMATS, format))
      throw new UsageError("compare reports as human, json, markdown or sarif");
    const { config, file } = await loadConfig(cwd, values.config);
    return compareCommand({
      config,
      configFile: file,
      flags,
      files,
      base: values.base,
      entry: only,
      cache: !values["no-cache"],
      explain: values.explain,
      visual: values.visual,
      scope: !values["no-scope"],
      format,
      report: values.report,
      io,
      summary,
    });
  }
  if (command === "coverage") {
    if (format !== "human" && format !== "json")
      throw new UsageError("coverage reports as human or json");
    const { config } = await loadConfig(cwd, values.config);
    const { coverageCommand } = await import("./coverage");
    return coverageCommand({ config, flags, entry: only, format, io });
  }
  if (command === "doctor") {
    const { config, file } = await loadConfig(cwd, values.config);
    const { doctorCommand } = await import("./doctor");
    return doctorCommand({ config, configFile: file, io });
  }
  if (command === "tokens") {
    if (format !== "human" && format !== "json")
      throw new UsageError("tokens reports as human or json");
    const { config } = await loadConfig(cwd, values.config);
    return tokensCommand({ config, flags, format, io });
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
