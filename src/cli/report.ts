import { version } from "../../package.json";
import type { SnapshotDiff } from "../browser/snapshot-diff";
import type { Histogram } from "../core/cascade";
import type { Specificity } from "../core/selector";
import type { ChangeGroup } from "../core/snapshot-diff";
import { pushTo } from "../core/util";
import type { DeadResult, DiffResult, FlipFinding, RuleRef } from "./commands";
import type { FixReport } from "./fix";
import type { SourceLocation } from "./sources";

export const FORMATS = ["human", "json", "github", "sarif"] as const;
type Format = (typeof FORMATS)[number];

/** Bumped on breaking changes to `--json` output. */
const SCHEMA = 1;
const json = (body: object) =>
  JSON.stringify({ schema: SCHEMA, ...body }, null, 2);

export type Summary = (title: string, report: () => string) => Promise<void>;

/** A ref, with its commit when the ref doesn't spell it. */
export const refLabel = (ref: string, sha: string) =>
  !sha || sha.startsWith(ref) ? ref : `${ref} (${sha.slice(0, 9)})`;
export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** The common shape of github and sarif output. */
interface Finding {
  rule: keyof typeof RULES;
  entry: string;
  message: string;
  source?: SourceLocation;
}

const RULES = {
  "dead-declaration": {
    level: "error",
    claim: "proof",
    title: "dead declaration",
    description:
      "Every selector of the rule is repeated, in the same context and scope, by a rule later in the cascade that sets this property: it can never win.",
  },
  "cascade-flip": {
    level: "error",
    claim: "heuristic",
    title: "cascade flip",
    description:
      "The winner between two rules that may match the same element changed for a property. Static and over-reporting by design: confirm with a computed-style snapshot.",
  },
  "order-tie-flip": {
    level: "warning",
    claim: "heuristic",
    title: "order-tie flip",
    description:
      "A rule that moved now wins or loses an equal-specificity tie. Review: whether both selectors ever match one element needs a computed-style snapshot.",
  },
} as const;

const spec = (s: Specificity) => `(${s.join(",")})`;
const at = (s?: SourceLocation) => (s ? `${s.file}:${s.line}` : "");
const where = (r: { context: string; layer: string; scope: string }) =>
  [r.context, r.layer && `@layer ${r.layer}`, r.scope]
    .filter(Boolean)
    .join(" / ");

function deadFindings(results: DeadResult[]): Finding[] {
  return results.flatMap(({ entry, dead }) =>
    dead.map((d) => ({
      rule: "dead-declaration" as const,
      entry,
      message: `${d.selector} { ${d.property}: ${d.value} } never wins: ${d.by.property}: ${d.by.value}${d.by.sameRule ? " later in the same rule" : " in a later rule"}${d.by.layer !== d.layer ? ` (@layer ${d.by.layer || "unlayered"})` : ""}`,
      source: d.source,
    })),
  );
}

const flipMessage = (f: FlipFinding, review: boolean) =>
  `${f.rule.selector} ${spec(f.rule.specificity)} now ${f.after} '${f.property}' against ${f.other.selector} ${spec(f.other.specificity)}${f.otherWas ? ` (was ${f.otherWas})` : ""}; before it ${f.before === "wins" ? "won" : "lost"}.${review ? " Equal-specificity tie after a move." : ""} Confirm with a computed-style snapshot.`;

function diffFindings(results: DiffResult[]): Finding[] {
  return results.flatMap(({ entry, flips, moveFlips }) => [
    ...flips.map((f) => ({
      rule: "cascade-flip" as const,
      entry,
      message: flipMessage(f, false),
      source: f.rule.source,
    })),
    ...moveFlips.map((f) => ({
      rule: "order-tie-flip" as const,
      entry,
      message: flipMessage(f, true),
      source: f.rule.source,
    })),
  ]);
}

const escapeData = (s: string) =>
  s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (s: string) =>
  escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

function github(findings: Finding[]): string {
  return findings
    .map((f) => {
      const r = RULES[f.rule];
      const props = [
        f.source && `file=${escapeProperty(f.source.file)}`,
        f.source && `line=${f.source.line}`,
        f.source && `col=${f.source.column + 1}`,
        `title=${escapeProperty(`crassus: ${r.title} (${r.claim}, ${f.entry})`)}`,
      ].filter(Boolean);
      return `::${r.level} ${props.join(",")}::${escapeData(f.message)}`;
    })
    .join("\n");
}

function sarif(findings: Finding[]): string {
  const ids = Object.keys(RULES) as (keyof typeof RULES)[];
  return JSON.stringify(
    {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "crassus",
              version,
              informationUri: "https://github.com/metonym/crassus",
              rules: ids.map((id) => ({
                id,
                name: RULES[id].title,
                shortDescription: { text: RULES[id].title },
                fullDescription: { text: RULES[id].description },
                defaultConfiguration: { level: RULES[id].level },
                properties: { claim: RULES[id].claim },
              })),
            },
          },
          results: findings.map((f) => ({
            ruleId: f.rule,
            ruleIndex: ids.indexOf(f.rule),
            level: RULES[f.rule].level,
            message: { text: f.message },
            locations: f.source
              ? [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: f.source.file },
                      region: {
                        startLine: f.source.line,
                        startColumn: f.source.column + 1,
                      },
                    },
                  },
                ]
              : [],
            properties: { entry: f.entry, claim: RULES[f.rule].claim },
          })),
        },
      ],
    },
    null,
    2,
  );
}

let plain = false;
const color = (code: number) => (s: string) =>
  !plain && process.stdout.isTTY && !process.env.NO_COLOR
    ? `\x1b[${code}m${s}\x1b[0m`
    : s;

/** Runs a formatter without color, for files. */
export function uncolored<T>(fn: () => T): T {
  plain = true;
  try {
    return fn();
  } finally {
    plain = false;
  }
}

const bold = color(1);
const dim = color(2);
const red = color(31);
const yellow = color(33);

const delta = (a: number, b: number) =>
  a === b ? `${b}` : `${a} -> ${b} (${b > a ? "+" : ""}${b - a})`;
const kb = (n: number) => `${(n / 1024).toFixed(1)}kB`;
/** `file:line` dimmed, and `gap` before what follows when there is one. */
const located = (s: SourceLocation | undefined, gap: string) =>
  `${dim(at(s))}${s ? gap : ""}`;

function deadHuman(results: DeadResult[]): string {
  const lines: string[] = [];
  for (const { entry, dead, bytes } of results) {
    if (results.length > 1) lines.push(bold(`## ${entry}`));
    for (const d of dead) {
      const w = where(d);
      lines.push(
        dim(at(d.source) || `${entry}:${d.loc?.line ?? "?"}`),
        `  ${w ? `${w} ` : ""}${d.selector}`,
        `  ${red(`${d.property}: ${d.value}`)}  <-  ${d.by.property}: ${d.by.value}${d.by.sameRule ? " (same rule)" : ""}`,
      );
    }
    lines.push(
      `${dead.length} dead declaration(s), ~${bytes} bytes in ${entry}`,
      "",
    );
  }
  const total = results.reduce((n, r) => n + r.dead.length, 0);
  if (total > 0)
    lines.push(
      dim(
        "proof: each always loses to a declaration later in the cascade for the same selector.",
      ),
    );
  return lines.join("\n").trimEnd();
}

const ruleLine = (r: RuleRef, sign: string) => {
  const w = where(r);
  return `  ${sign} ${located(r.source, " ")}${w ? `[${w}] ` : ""}${r.selector} { ${r.declarations} }`;
};

function histogramLines(b: Histogram, h: Histogram): string[] {
  return [
    `selectors: ${delta(b.selectors, h.selectors)}  max: ${spec(b.max)} -> ${spec(h.max)}`,
    `classes  1: ${delta(b.classes[1], h.classes[1])}  2: ${delta(b.classes[2], h.classes[2])}  3: ${delta(b.classes[3], h.classes[3])}  >=4: ${delta(b.classes[4], h.classes[4])}  element-qualified: ${delta(b.qualified, h.qualified)}`,
  ];
}

function diffHuman(
  results: DiffResult[],
  base: { ref: string; sha: string },
  verbose: boolean,
): string {
  const lines: string[] = [
    `base: ${refLabel(base.ref, base.sha)}  head: ${base.sha ? "working tree" : "the second file"}`,
  ];
  const section = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push("", bold(`### ${title} (${items.length})`), ...items);
  };
  const flipLines = (f: FlipFinding) =>
    `  ${located(f.rule.source, "  ")}${f.rule.selector} ${spec(f.rule.specificity)} now ${f.after} '${f.property}' vs\n` +
    `    ${located(f.other.source, "  ")}${f.other.selector} ${spec(f.other.specificity)}${f.otherWas ? ` (was ${f.otherWas})` : ""}\n` +
    `    (before: ${f.before})`;
  for (const r of results) {
    const { size, counts: c } = r;
    lines.push("", bold(`## ${r.entry}`));
    lines.push(...histogramLines(r.histogram.base, r.histogram.head));
    lines.push(
      `size (min / gzip / zstd, as Bun ${Bun.version} minifies it; a trend, not a budget): ${kb(size.base.min)} / ${kb(size.base.gzip)} / ${kb(size.base.zstd)} -> ${kb(size.head.min)} / ${kb(size.head.gzip)} / ${kb(size.head.zstd)}  (${delta(size.base.min, size.head.min)} B min, ${delta(size.base.gzip, size.head.gzip)} B gzip)`,
    );
    if (r.files.some((f) => f.base || f.head)) {
      lines.push("top files by selectors at >=3 classes (base -> head):");
      for (const f of r.files)
        lines.push(
          `  ${String(f.head).padStart(4)}  ${delta(f.base, f.head).padEnd(18)} ${f.file}`,
        );
    }
    lines.push(
      `removed: ${c.removed}  added: ${c.added}  rewrites (same decls, new selector): ${c.rewrites}  new rules: ${c.newRules}  dropped rules: ${c.droppedRules}  moved rules: ${c.movedRules}  context moves: ${c.contextMoves}`,
    );
    section(
      "dropped rules (in base, no head rule with the same declarations)",
      r.dropped.map((x) => ruleLine(x, "-")),
    );
    section(
      "new rules (in head, no base rule with the same declarations)",
      r.newRules.map((x) => ruleLine(x, "+")),
    );
    section(
      "rewrites",
      r.rewrites.map(
        ({ from, to }) =>
          `  ${from.selector} ${spec(from.specificity)}\n    -> ${to.selector} ${spec(to.specificity)}`,
      ),
    );
    section(
      "context moves (same selector and declarations, context, layer or scope changed)",
      r.contextMoves.map(
        ({ from, to }) =>
          `  [${where(from) || "(none)"}] ${from.selector}\n    -> [${where(to) || "(none)"}] ${to.selector}`,
      ),
    );
    section(
      red(
        "CASCADE FLIPS: winner changed against a co-matchable rule (heuristic; confirm with a computed-style snapshot)",
      ),
      r.flips.map(flipLines),
    );
    const byRule = new Map<RuleRef, FlipFinding[]>();
    for (const f of r.moveFlips) pushTo(byRule, f.rule, f);
    section(
      yellow(
        "order-tie flips from moved rules (review; confirm with a computed-style snapshot)",
      ),
      [...byRule.values()].map((list) => {
        const { rule, after } = list[0];
        const others = [...new Set(list.map((f) => f.other.selector))];
        const props = [...new Set(list.map((f) => f.property))];
        const shown = verbose ? others : others.slice(0, 4);
        return (
          `  ${located(rule.source, "  ")}${rule.selector} ${spec(rule.specificity)} now ${after} [${props.join(", ")}] vs\n` +
          shown.map((o) => `    ${o}`).join("\n") +
          (others.length > shown.length
            ? `\n    (+${others.length - shown.length} more)`
            : "")
        );
      }),
    );
  }
  const flips = results.reduce((n, r) => n + r.flips.length, 0);
  if (flips > 0)
    lines.push("", red(`${flips} cascade flip(s); inspect before merging.`));
  return lines.join("\n");
}

export function formatDead(results: DeadResult[], format: Format): string {
  if (format === "json") return json({ command: "dead", results });
  if (format === "github") return github(deadFindings(results));
  if (format === "sarif") return sarif(deadFindings(results));
  return deadHuman(results);
}

export function formatDiff(
  results: DiffResult[],
  base: { ref: string; sha: string },
  format: Format,
  verbose: boolean,
): string {
  if (format === "json") return json({ command: "diff", base, results });
  if (format === "github") return github(diffFindings(results));
  if (format === "sarif") return sarif(diffFindings(results));
  return diffHuman(results, base, verbose);
}

export function formatFix(
  report: FixReport,
  results: DeadResult[],
  format: Format,
): string {
  if (format === "json") {
    const { patch, ...fix } = report;
    return json({
      command: "dead",
      fix: patch ? { ...fix, patch } : fix,
      results,
    });
  }
  const lines: string[] = [];
  if (report.patch) lines.push(report.patch.trimEnd(), "");
  const verb = report.written ? "deleted" : "would delete";
  for (const f of report.fixed)
    lines.push(
      `${dim(`${f.file}:${f.line}`)}  ${verb} ${f.selector} { ${red(`${f.property}: ${f.value}`)} }  ${dim(`(${f.by.property}: ${f.by.value} wins)`)}`,
    );
  if (report.skipped.length > 0) {
    lines.push("", bold(`### left as is (${report.skipped.length})`));
    for (const k of report.skipped)
      lines.push(
        `  ${located(k.source, "  ")}${k.selector} { ${k.property}: ${k.value} }`,
        `    ${yellow(k.reason)}`,
      );
  }
  lines.push(
    "",
    `${report.fixed.length} dead declaration(s) ${report.written ? "deleted" : "to delete"} in ${report.files.length} file(s); ${report.skipped.length} left.`,
  );
  const wins =
    "Each one never wins: make sure the value that wins is the one you meant.";
  const note = report.written
    ? report.check === "verified"
      ? `Checked: re-analyzed, the stylesheets lost exactly these declarations. ${wins}`
      : "Sources were edited but crassus can't rebuild them here: rebuild, then run crassus dead again."
    : report.check === "verified"
      ? `Checked in memory: the stylesheets would lose exactly these declarations. ${wins}`
      : "Edits to sources are checked when written: crassus rebuilds, re-analyzes, and undoes the fix if anything else changed.";
  if (report.fixed.length > 0) lines.push(dim(note));
  return lines.join("\n");
}

const MAX_PAGES = 6;
const MAX_PROPS = 8;
const MAX_INVISIBLE = 10;
const props = (list: string[]) =>
  list.slice(0, MAX_PROPS).join(", ") +
  (list.length > MAX_PROPS ? ` (+${list.length - MAX_PROPS})` : "");

export function formatSnapshotDiff(
  diff: SnapshotDiff,
  format: "human" | "json",
  command: "snapshot-diff" | "compare" = "snapshot-diff",
): string {
  if (format === "json")
    return json({ command, claim: "ground truth", ...diff });
  const lines = [
    `${diff.files} page(s), ${diff.entries} element entries compared ${dim("(ground truth for the captured fixtures, themes, viewports and states)")}`,
  ];
  for (const f of diff.onlyBase) lines.push(yellow(`only in base: ${f}`));
  for (const f of diff.onlyHead) lines.push(yellow(`only in head: ${f}`));
  const paths = diff.pages.filter((p) => p.removed.length || p.added.length);
  if (paths.length > 0) {
    lines.push(
      "",
      bold("Elements on one side only (DOM or state changes; not diffed)"),
    );
    for (const p of paths)
      lines.push(
        `  ${p.file}: ${p.removed.length} only in base, ${p.added.length} only in head`,
      );
  }
  const { onlyBase, onlyHead } = diff.uncompared;
  if (onlyBase.length || onlyHead.length) {
    lines.push(
      "",
      bold(
        "Not compared (one side's stylesheets don't declare them, so it didn't record them)",
      ),
    );
    if (onlyBase.length) lines.push(`  only base recorded ${props(onlyBase)}`);
    if (onlyHead.length) lines.push(`  only head recorded ${props(onlyHead)}`);
  }
  const visible = diff.groups.filter((g) => !g.invisible);
  const invisible = diff.groups.filter((g) => g.invisible);
  const group = (g: ChangeGroup, color: (s: string) => string) => {
    const more = g.pages.length - MAX_PAGES;
    lines.push(
      "",
      `${g.count}×  ${g.property}: ${color(g.before)} -> ${color(g.after)}${g.invisible ? dim(` (${g.invisible})`) : ""}`,
      ...(g.aliases ? [`     ${dim("also:")} ${props(g.aliases)}`] : []),
      `     ${dim("pages:")} ${g.pages.slice(0, MAX_PAGES).join(", ")}${more > 0 ? ` (+${more})` : ""}`,
      ...g.examples.map((e) => `     ${dim("e.g.")} ${e.page}  ${e.path}`),
    );
  };
  const total = (gs: ChangeGroup[]) => gs.reduce((n, g) => n + g.count, 0);
  if (visible.length === 0)
    lines.push(
      "",
      invisible.length
        ? "No visible computed-style differences."
        : "No computed-style differences.",
    );
  else {
    const pages = new Set(visible.flatMap((g) => g.pages)).size;
    lines.push(
      "",
      bold(
        `${visible.length} distinct change(s), ${total(visible)} in all, on ${pages} page(s):`,
      ),
    );
    for (const g of visible) group(g, red);
  }
  if (invisible.length > 0) {
    lines.push(
      "",
      bold(
        `${invisible.length} invisible change(s), ${total(invisible)} in all (no one can see them on either side; not failed on):`,
      ),
    );
    for (const g of invisible.slice(0, MAX_INVISIBLE)) group(g, dim);
    if (invisible.length > MAX_INVISIBLE)
      lines.push(
        "",
        dim(
          `(+${invisible.length - MAX_INVISIBLE} more; --format json lists them)`,
        ),
      );
  }
  return lines.join("\n");
}

/** GitHub's cap on a step summary. */
const SUMMARY_LIMIT = 1024 * 1024;

/** Appends a report to a GitHub step summary, cut at a line to fit the cap. */
export async function appendSummary(
  file: string,
  title: string,
  report: string,
): Promise<void> {
  const existing = await Bun.file(file)
    .text()
    .catch(() => "");
  const fence = report.includes("```") ? "~~~~" : "```";
  const open = `### ${title}\n\n${fence}text\n`;
  const close = `\n${fence}\n`;
  const budget =
    SUMMARY_LIMIT -
    Buffer.byteLength(existing) -
    Buffer.byteLength(open + close) -
    200;
  let body = report;
  if (Buffer.byteLength(body) > budget) {
    const lines = body.split("\n");
    let size = 0;
    let kept = 0;
    while (kept < lines.length) {
      const next = Buffer.byteLength(lines[kept]) + 1;
      if (size + next > budget) break;
      size += next;
      kept++;
    }
    body = `${lines.slice(0, kept).join("\n")}\n… ${lines.length - kept} more line(s) cut to fit GitHub's 1 MiB step summary; run crassus locally for the full report.`;
  }
  await Bun.write(file, `${existing}${open}${body}${close}`);
}
