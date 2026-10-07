/**
 * `report.md` for `crassus usage`: what the fixtures say about the library
 * stylesheet, worst first, with how far it can be trusted.
 */
import type { UsageFile } from "../browser/usage";
import type { DeclarationStats } from "../core/usage";
import { bytesOf } from "../core/usage";

const PIPE_RE = /\|/g;
const NEWLINE_RE = /\s*\n\s*/g;

/** A table cell: one line, pipes escaped. */
const cell = (s: string) => s.replace(NEWLINE_RE, " ").replace(PIPE_RE, "\\|");
const code = (s: string) =>
  s ? (s.includes("`") ? `\`\` ${cell(s)} \`\`` : `\`${cell(s)}\``) : "";
const n = (x: number) => x.toLocaleString("en-US");

const declaration = (d: DeclarationStats) =>
  code(`${d.property}: ${d.value}${d.important ? " !important" : ""}`);

const byBytes = (a: DeclarationStats, b: DeclarationStats) =>
  bytesOf(b) - bytesOf(a) || b.matched - a.matched;

const lostTo = (d: DeclarationStats) =>
  Object.entries(d.lostTo)
    .sort((a, b) => b[1] - a[1])
    .map(([rule, times]) => `${code(rule)} ×${n(times)}`)
    .join(", ");

export function formatUsageReport(
  usage: UsageFile,
  run: {
    themes: string[];
    viewports?: { width: number; height: number }[];
    states: boolean;
    readySelector?: string;
  },
): string {
  const s = usage.summary;
  const dead = [...usage.deadInFixtures].sort(byBytes);
  const fold = [...usage.foldCandidates].sort(byBytes);
  const unmatched = [...usage.unmatched].sort((a, b) => b.bytes - a.bytes);
  const viewports = run.viewports?.length
    ? run.viewports.map((v) => `${v.width}x${v.height}`).join(", ")
    : "1280x900";
  const lines = [
    "# crassus usage report",
    "",
    `**Evidence, not proof** (rung 2). Every finding is bounded by what the run covered: ${n(s.fixtures)} fixture page(s), theme(s) ${run.themes.join(", ")}, viewport(s) ${viewports}, ${run.states ? "forced `:hover`/`:focus`/`:active` states" : "no forced states"}, and \`prefers-reduced-motion: reduce\` emulated. A declaration that never wins here may win on a page, theme, viewport or state the fixtures don't cover.`,
    "",
    "| | |",
    "|:---|:---|",
    `| Pages | ${n(s.fixtures * s.themes * s.viewports)} (${n(s.fixtures)} fixtures × ${n(s.themes)} themes × ${n(s.viewports)} viewports), ${n(s.observations)} observations |`,
    `| Rules matched | ${n(s.rulesMatched)} of ${n(s.rulesTotal)} |`,
    `| Declarations matched | ${n(s.declarationsTotal)}: ${n(s.declarationsEverWon)} won somewhere, ${n(s.declarationsNeverWon)} never won (${n(s.bytesNeverWon)} bytes) |`,
    `| Fold candidates | ${n(fold.length)} |`,
    `| Rules never matched | ${n(unmatched.length)} (${n(s.bytesUnmatchedRules)} bytes) |`,
  ];
  if (usage.notReady.length)
    lines.push(
      `| Not ready | ${usage.notReady.length} page(s) never matched ${code(run.readySelector ?? "")}: ${usage.notReady.map(code).join(", ")} |`,
    );

  lines.push(
    "",
    `## Dead in fixtures (${n(dead.length)})`,
    "",
    "Declarations that matched at least once and never won, largest first. Declarations that lose only to `prefers-reduced-motion`, `prefers-contrast` or `forced-colors` rules are left out: those rules are alternatives for a user preference, not overrides.",
    "",
  );
  if (dead.length) {
    lines.push(
      "| Bytes | Declaration | Rule | Matched | Lost to |",
      "|---:|:---|:---|---:|:---|",
    );
    for (const d of dead)
      lines.push(
        `| ${bytesOf(d)} | ${declaration(d)} | ${code(d.selector)}${d.context ? ` in ${code(d.context)}` : ""} | ${n(d.matched)} | ${lostTo(d)} |`,
      );
  } else lines.push("None.");

  lines.push(
    "",
    `## Fold candidates (${n(fold.length)})`,
    "",
    "Dead declarations that always lose to the same single rule: candidates for merging into it.",
    "",
  );
  if (fold.length) {
    lines.push(
      "| Bytes | Declaration | Rule | Always loses to |",
      "|---:|:---|:---|:---|",
    );
    for (const d of fold)
      lines.push(
        `| ${bytesOf(d)} | ${declaration(d)} | ${code(d.selector)}${d.context ? ` in ${code(d.context)}` : ""} | ${code(Object.keys(d.lostTo)[0])} |`,
      );
  } else lines.push("None.");

  lines.push(
    "",
    `## Never matched (${n(unmatched.length)})`,
    "",
    "Rules no element matched on any page, largest first.",
    "",
  );
  if (unmatched.length) {
    lines.push("| Bytes | Rule | Context |", "|---:|:---|:---|");
    for (const r of unmatched)
      lines.push(`| ${r.bytes} | ${code(r.selector)} | ${code(r.context)} |`);
  } else lines.push("None.");
  return `${lines.join("\n")}\n`;
}
