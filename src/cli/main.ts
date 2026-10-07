/**
 * `crassus` CLI. Exit codes: 0 clean, 1 findings, 2 usage or environment
 * error. Review sections (order-tie flips) never fail a run.
 */
import { parseArgs } from "node:util";
import { version } from "../../package.json";
import { baseStylesheets } from "./baseline";
import {
  type BrowserFlags,
  captureCommand,
  snapshotDiffCommand,
  usageCommand,
} from "./browser";
import { runDead, runDiff } from "./commands";
import { FixCheckError, fix } from "./fix";
import { filesAsSheets, loadConfig, stylesheets, UsageError } from "./project";
import {
  FORMATS,
  type Format,
  formatDead,
  formatDiff,
  formatFix,
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
  crassus snapshot-diff <baseDir> <headDir>
                                 compare two captures (ground truth)
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

Browser options (capture, usage; override the config's \`browser\`):
  --only <text>      only fixtures whose name contains this
  --themes <a,b>     themes to load each page in
  --viewport <WxH>   viewport (repeatable)
  --no-states        skip forced :hover/:focus/:active states
  --engine <name>    chrome (default) or webkit
  --matcher <name>   usage: dom (default, any engine) or cdp (Chrome)
  --concurrency <n>  tabs in parallel (default 8)
  --url <base>       use a running server instead of building and serving
  --out <dir>        usage: output directory (default .crassus/usage)
  -h, --help         show this help
  -v, --version      show the version

Exit codes: 0 clean, 1 findings (snapshot-diff: any difference; capture: a
page never matched readySelector), 2 usage error. usage always exits 0.`;

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
    if (
      e instanceof UsageError ||
      e instanceof FixCheckError ||
      (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")
    ) {
      io.err(`crassus: ${(e as Error).message}`);
      return 2;
    }
    io.err(`crassus: ${(e as Error).stack ?? e}`);
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
      out: { type: "string" },
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
  const format = (values.json ? "json" : (values.format ?? "human")) as Format;
  if (!FORMATS.includes(format))
    throw new UsageError(
      `unknown format ${format} (one of ${FORMATS.join(", ")})`,
    );
  const only = values.entry ?? [];
  const { cwd } = io;
  const human = format === "human";

  if (values["dry-run"] && !values.fix)
    throw new UsageError("--dry-run goes with --fix");
  if (command === "dead") {
    const { config } = await loadConfig(cwd, values.config);
    const load = () =>
      files.length > 0
        ? filesAsSheets(cwd, files)
        : stylesheets(cwd, config, only);
    const sheets = await load();
    const results = runDead(sheets);
    if (!values.fix) {
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
      if (human)
        io.err(
          `crassus: base ${b.sha.startsWith(ref) ? ref : `${ref} (${b.sha.slice(0, 9)})`} ${b.cached ? "from cache" : `built in ${((performance.now() - started) / 1000).toFixed(1)} s`}`,
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
    io.out(formatDiff(results, base, format, values.verbose ?? false));
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
    return snapshotDiffCommand({ cwd, dirs: files, format, io });
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
      return usageCommand({ cwd, config, flags, outDir: values.out, io });
    }
    const outDir = files[0] ?? values.out;
    if (!outDir || files.length > 1 || (files[0] && values.out))
      throw new UsageError("capture takes one output directory");
    return captureCommand({
      cwd,
      config,
      flags,
      outDir,
      base: values.base,
      io,
    });
  }

  throw new UsageError(`unknown command ${command} (run crassus --help)`);
}
