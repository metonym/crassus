// `crassus bisect <from>..<to>`: which commits in a range changed computed
// styles on today's fixtures. The range is cut into segments, each segment's
// end stylesheets are compared, and a segment with visible changes is halved
// until the commits that made them are found.
import { $ } from "bun";
import type { SnapshotDiff } from "../browser/snapshot-diff";
import type { Config } from "../core/config";
import { baseStylesheets } from "./baseline";
import {
  type BrowserFlags,
  comparer,
  differs,
  notReadyLine,
  pick,
} from "./browser";
import type { Io } from "./main";
import { UsageError } from "./project";
import { formatSnapshotDiff, type Summary, seconds } from "./report";
import type { Sheet } from "./sources";

const GROUP_BY = ["type", "commit"] as const;
export type GroupBy = (typeof GROUP_BY)[number];

export interface Commit {
  sha: string;
  subject: string;
  /** The conventional-commit type (`perf`, `fix`), or `other`. */
  type: string;
}

interface Segment {
  /** The commit before the segment's first. */
  from: string;
  to: string;
  commits: Commit[];
}

export interface BisectResult {
  from: string;
  to: string;
  commits: { sha: string; subject: string }[];
  /** `unchanged`: the stylesheet is byte-identical at both ends: not compared. */
  css: "changed" | "unchanged";
  /** Element changes users can see, and those no one can. */
  visible?: number;
  invisible?: number;
  diff?: SnapshotDiff;
  /** The halves, when it had visible changes and more than one commit. */
  parts?: BisectResult[];
}

const TYPE_RE = /^(\w+)(?:\([^)]*\))?!?:/;
const RANGE_RE = /^(.+?)\.\.(.*)$/;

/** Consecutive commits of one type (or each commit) form a segment. */
export function segments(
  from: string,
  commits: Commit[],
  groupBy: GroupBy,
): Segment[] {
  const out: Segment[] = [];
  let start = from;
  for (const c of commits) {
    const last = out.at(-1);
    if (groupBy === "type" && last && last.commits[0].type === c.type) {
      last.commits.push(c);
      last.to = c.sha;
    } else out.push({ from: start, to: c.sha, commits: [c] });
    start = c.sha;
  }
  return out;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await $`git ${args}`.cwd(cwd).quiet().nothrow();
  if (r.exitCode !== 0)
    throw new UsageError(
      `git ${args.join(" ")}: ${r.stderr.toString().trim()}`,
    );
  return r.text().trim();
}

/** First-parent commits after `from` up to `to`, oldest first. */
async function commitsIn(cwd: string, from: string, to: string) {
  const sha = (ref: string) =>
    git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(
      () => {
        throw new UsageError(`unknown git ref: ${ref}`);
      },
    );
  const [a, b] = await Promise.all([sha(from), sha(to)]);
  const log = await git(cwd, [
    "log",
    "--first-parent",
    "--reverse",
    "--format=%H%x09%s",
    `${a}..${b}`,
  ]);
  const commits = log
    ? log.split("\n").map((line) => {
        const [hash, subject = ""] = line.split("\t");
        return {
          sha: hash,
          subject,
          type: TYPE_RE.exec(subject)?.[1].toLowerCase() ?? "other",
        };
      })
    : [];
  return { from: a, commits };
}

const short = (sha: string) => sha.slice(0, 9);
const count = (diff: SnapshotDiff, invisible: boolean) =>
  diff.groups
    .filter((g) => Boolean(g.invisible) === invisible)
    .reduce((n, g) => n + g.count, 0);

/** `crassus bisect <from>..<to>`. Exit 1 when a commit changed what users see. */
export async function bisectCommand(opts: {
  config: Config;
  configFile?: string;
  flags: BrowserFlags;
  range: string[];
  groupBy: string;
  split: boolean;
  entry: string[];
  cache: boolean;
  explain?: boolean;
  visual?: boolean;
  format: "human" | "json";
  io: Io;
  summary?: Summary;
}): Promise<number> {
  const { io } = opts;
  const { cwd } = io;
  const m = opts.range.length === 1 ? RANGE_RE.exec(opts.range[0]) : null;
  if (!m) throw new UsageError("bisect takes one range: <from>..<to>");
  const groupBy = opts.groupBy as GroupBy;
  if (!GROUP_BY.includes(groupBy))
    throw new UsageError(`--group-by takes ${GROUP_BY.join(" or ")}`);
  const cmp = comparer({ ...opts, cwd });
  const to = m[2] || "HEAD";
  const { from, commits } = await commitsIn(cwd, m[1], to);
  if (commits.length === 0)
    throw new UsageError(`no commits in ${m[1]}..${to}`);
  const human = opts.format === "human";
  const progress = (text: string) => human && io.err(`crassus: ${text}`);
  const configText = opts.configFile
    ? await Bun.file(opts.configFile).text()
    : "";

  const built = new Map<string, Promise<Sheet>>();
  const cssAt = (sha: string) => {
    let sheet = built.get(sha);
    if (!sheet) {
      sheet = baseStylesheets({
        cwd,
        ref: sha,
        config: opts.config,
        configText,
        only: opts.entry,
        cache: opts.cache,
      }).then((b) => pick(b.sheets, opts.entry));
      built.set(sha, sheet);
    }
    return sheet;
  };

  const notReady = new Set<string>();
  let compared = 0;
  const examine = async (
    seg: Segment,
    label: string,
  ): Promise<BisectResult> => {
    const result: BisectResult = {
      from: seg.from,
      to: seg.to,
      commits: seg.commits.map(({ sha, subject }) => ({ sha, subject })),
      css: "unchanged",
    };
    const [base, head] = [await cssAt(seg.from), await cssAt(seg.to)];
    if (base.css === head.css) return result;
    const run = await cmp.run({ base, head });
    compared++;
    for (const p of run.notReady) notReady.add(p);
    progress(
      `${label} ${short(seg.from)}..${short(seg.to)}: ${count(run.result, false)} visible change(s) in ${seconds(run.ms)}`,
    );
    Object.assign(result, {
      css: "changed",
      visible: count(run.result, false),
      invisible: count(run.result, true),
      diff: run.result,
    });
    if (opts.split && differs(run.result) && seg.commits.length > 1) {
      const mid = Math.ceil(seg.commits.length / 2);
      const halves: Segment[] = [
        {
          from: seg.from,
          to: seg.commits[mid - 1].sha,
          commits: seg.commits.slice(0, mid),
        },
        {
          from: seg.commits[mid - 1].sha,
          to: seg.to,
          commits: seg.commits.slice(mid),
        },
      ];
      result.parts = [];
      // biome-ignore lint/performance/noAwaitInLoops: one browser run at a time
      for (const h of halves) result.parts.push(await examine(h, `${label} >`));
    }
    return result;
  };

  const segs = segments(from, commits, groupBy);
  progress(
    `bisecting ${commits.length} commit(s) in ${segs.length} segment(s) by ${groupBy}`,
  );
  const started = performance.now();
  const results: BisectResult[] = [];
  for (const [i, seg] of segs.entries()) {
    const label = `segment ${i + 1}/${segs.length}`;
    // biome-ignore lint/performance/noAwaitInLoops: one browser run at a time
    results.push(await examine(seg, label));
  }
  progress(
    `${compared} comparison(s) in ${seconds(performance.now() - started)}`,
  );

  const report = (format: "human" | "json") =>
    formatBisect(
      { from: m[1], to, groupBy, commits: commits.length, segments: results },
      format,
    );
  await opts.summary?.(`crassus bisect ${m[1]}..${to}`, () => report("human"));
  io.out(report(opts.format));
  if (notReady.size)
    io.err(notReadyLine([...notReady], cmp.pages.readySelector, "compared"));
  return found(results).length > 0 || notReady.size > 0 ? 1 : 0;
}

/** The narrowest results with visible changes: where the halves don't show them. */
export function found(results: BisectResult[]): BisectResult[] {
  return results.flatMap((r) => {
    if (!r.diff || !differs(r.diff)) return [];
    const inner = found(r.parts ?? []);
    return inner.length > 0 ? inner : [r];
  });
}

function formatBisect(
  run: {
    from: string;
    to: string;
    groupBy: GroupBy;
    commits: number;
    segments: BisectResult[];
  },
  format: "human" | "json",
): string {
  if (format === "json")
    return JSON.stringify(
      { schema: 1, command: "bisect", claim: "ground truth", ...run },
      null,
      2,
    );
  const title = (r: BisectResult) =>
    r.commits.length === 1
      ? `${short(r.commits[0].sha)} ${r.commits[0].subject}`
      : `${r.commits.length} commits (${[...new Set(r.commits.map((c) => TYPE_RE.exec(c.subject)?.[1] ?? "other"))].join(", ")})`;
  const status = (r: BisectResult) =>
    r.css === "unchanged"
      ? "CSS unchanged"
      : r.visible
        ? `${r.visible} visible change(s)${r.invisible ? `, ${r.invisible} invisible` : ""}`
        : `no visible change${r.invisible ? ` (${r.invisible} invisible)` : ""}`;
  const lines = [
    `${run.commits} commit(s) in ${run.from}..${run.to}, in ${run.segments.length} segment(s) by ${run.groupBy} (ground truth for the captured fixtures, themes, viewports and states)`,
    "",
  ];
  const tree = (rs: BisectResult[], indent: string) => {
    for (const r of rs) {
      lines.push(
        `${indent}${short(r.from)}..${short(r.to)}  ${title(r)}  ${status(r)}`,
      );
      tree(r.parts ?? [], `${indent}    `);
    }
  };
  tree(run.segments, "  ");
  const hits = found(run.segments);
  if (hits.length === 0) {
    lines.push("", "No commit changed what users see on the fixtures.");
    return lines.join("\n");
  }
  for (const r of hits)
    lines.push(
      "",
      `== ${short(r.from)}..${short(r.to)}  ${title(r)}`,
      ...(r.commits.length > 1
        ? r.commits.map((c) => `   ${short(c.sha)} ${c.subject}`)
        : []),
      "",
      formatSnapshotDiff(r.diff as SnapshotDiff, "human", "compare"),
    );
  return lines.join("\n");
}
