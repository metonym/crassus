/**
 * Output formats: human (the default), `json` (stable schema), `github`
 * (workflow annotations at the source line) and `sarif` (code scanning).
 * Every finding says how far it can be trusted.
 */
import { version } from "../../package.json";
import type { Histogram } from "../core/cascade";
import type { Specificity } from "../core/selector";
import type { DeadResult, DiffResult, FlipFinding, RuleRef } from "./commands";
import type { FixReport } from "./fix";
import type { SourceLocation } from "./sources";

export type Format = "human" | "json" | "github" | "sarif";
export const FORMATS: Format[] = ["human", "json", "github", "sarif"];

/** Bumped on breaking changes to `--json` output. */
const SCHEMA = 1;

// ---------------------------------------------------------------------------
// Findings: the common shape of github and sarif output

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

// ---------------------------------------------------------------------------
// GitHub workflow commands

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

// ---------------------------------------------------------------------------
// SARIF 2.1.0

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

// ---------------------------------------------------------------------------
// Human

const color = (code: number) => (s: string) =>
  process.stdout.isTTY && !process.env.NO_COLOR
    ? `\x1b[${code}m${s}\x1b[0m`
    : s;
const bold = color(1);
const dim = color(2);
const red = color(31);
const yellow = color(33);

const delta = (a: number, b: number) =>
  a === b ? `${b}` : `${a} -> ${b} (${b > a ? "+" : ""}${b - a})`;
const kb = (n: number) => `${(n / 1024).toFixed(1)}kB`;

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

const ruleLine = (r: RuleRef, sign: string) =>
  `  ${sign} ${dim(at(r.source))}${r.source ? " " : ""}${where(r) ? `[${where(r)}] ` : ""}${r.selector} { ${r.declarations} }`;

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
    `base: ${base.sha && !base.sha.startsWith(base.ref) ? `${base.ref} (${base.sha.slice(0, 9)})` : base.ref}  head: ${base.sha ? "working tree" : "the second file"}`,
  ];
  const section = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push("", bold(`### ${title} (${items.length})`), ...items);
  };
  const flipLines = (f: FlipFinding) =>
    `  ${dim(at(f.rule.source))}${f.rule.source ? "  " : ""}${f.rule.selector} ${spec(f.rule.specificity)} now ${f.after} '${f.property}' vs\n` +
    `    ${dim(at(f.other.source))}${f.other.source ? "  " : ""}${f.other.selector} ${spec(f.other.specificity)}${f.otherWas ? ` (was ${f.otherWas})` : ""}\n` +
    `    (before: ${f.before})`;
  for (const r of results) {
    const { size, counts: c } = r;
    lines.push("", bold(`## ${r.entry}`));
    lines.push(...histogramLines(r.histogram.base, r.histogram.head));
    lines.push(
      `size (min / gzip / zstd, as Bun minifies it; a trend, not a budget): ${kb(size.base.min)} / ${kb(size.base.gzip)} / ${kb(size.base.zstd)} -> ${kb(size.head.min)} / ${kb(size.head.gzip)} / ${kb(size.head.zstd)}  (${delta(size.base.min, size.head.min)} B min, ${delta(size.base.gzip, size.head.gzip)} B gzip)`,
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
    // The review section groups by moved rule.
    const byRule = new Map<RuleRef, FlipFinding[]>();
    for (const f of r.moveFlips) {
      const key = f.rule;
      const list = byRule.get(key);
      if (list) list.push(f);
      else byRule.set(key, [f]);
    }
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
          `  ${dim(at(rule.source))}${rule.source ? "  " : ""}${rule.selector} ${spec(rule.specificity)} now ${after} [${props.join(", ")}] vs\n` +
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

// ---------------------------------------------------------------------------

export function formatDead(results: DeadResult[], format: Format): string {
  if (format === "json")
    return JSON.stringify(
      { schema: SCHEMA, command: "dead", results },
      null,
      2,
    );
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
  if (format === "json")
    return JSON.stringify(
      { schema: SCHEMA, command: "diff", base, results },
      null,
      2,
    );
  if (format === "github") return github(diffFindings(results));
  if (format === "sarif") return sarif(diffFindings(results));
  return diffHuman(results, base, verbose);
}

/** `dead --fix` (human or json). */
export function formatFix(
  report: FixReport,
  results: DeadResult[],
  format: Format,
): string {
  if (format === "json") {
    const { patch, ...fix } = report;
    return JSON.stringify(
      {
        schema: SCHEMA,
        command: "dead",
        fix: patch ? { ...fix, patch } : fix,
        results,
      },
      null,
      2,
    );
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
        `  ${dim(at(k.source))}${k.source ? "  " : ""}${k.selector} { ${k.property}: ${k.value} }`,
        `    ${yellow(k.reason)}`,
      );
  }
  const files = report.files.length;
  lines.push(
    "",
    `${report.fixed.length} dead declaration(s) ${report.written ? "deleted" : "to delete"} in ${files} file(s); ${report.skipped.length} left.`,
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
