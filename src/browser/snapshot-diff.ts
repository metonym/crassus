import path from "node:path";
import {
  type ChangeGroup,
  diffSnapshot,
  groupChanges,
  type PageDiff,
} from "../core/snapshot-diff";
import {
  type CaptureManifest,
  MANIFEST,
  parseSnapshotFile,
  readSnapshot,
} from "./snapshot";

export interface SnapshotPageDiff extends PageDiff {
  /** `<name>.<theme>[.<W>x<H>].json.gz` */
  file: string;
  fixture: string;
  theme: string;
  /** `WxH`, when the capture had several viewports. */
  viewport?: string;
}

export interface SnapshotDiff {
  /** Files on both sides, compared. */
  files: number;
  /** Element entries in base's compared files. */
  entries: number;
  onlyBase: string[];
  onlyHead: string[];
  /** Pages with any change, by file name. */
  pages: SnapshotPageDiff[];
  /** Style changes grouped by `(property, before -> after)`, most frequent first. */
  groups: ChangeGroup[];
}

export interface SnapshotDiffOptions {
  /** Example paths per group. Default 3. */
  examples?: number;
}

/** Thrown for a directory without `capture`'s manifest. */
export class IncompleteCaptureError extends Error {
  readonly dir: string;
  constructor(dir: string) {
    super(
      `${dir} isn't a complete capture (no ${MANIFEST}): the capture failed or is still running, or crassus 0.1 made it. Capture it again.`,
    );
    this.dir = dir;
  }
}

async function snapshotFiles(dir: string): Promise<string[]> {
  const manifest = Bun.file(path.join(dir, MANIFEST));
  if (!(await manifest.exists())) throw new IncompleteCaptureError(dir);
  return ((await manifest.json()) as CaptureManifest).files;
}

/**
 * Diffs two `capture` output directories; a file on one side only is listed,
 * not diffed. Throws `IncompleteCaptureError` for a directory `capture`
 * didn't finish.
 */
export async function diffSnapshots(
  baseDir: string,
  headDir: string,
  options: SnapshotDiffOptions = {},
): Promise<SnapshotDiff> {
  const [base, head] = await Promise.all([
    snapshotFiles(baseDir),
    snapshotFiles(headDir),
  ]);
  const inHead = new Set(head);
  const inBase = new Set(base);
  const out: SnapshotDiff = {
    files: 0,
    entries: 0,
    onlyBase: base.filter((f) => !inHead.has(f)),
    onlyHead: head.filter((f) => !inBase.has(f)),
    pages: [],
    groups: [],
  };
  for (const file of base) {
    if (!inHead.has(file)) continue;
    // One pair in memory at a time: a page's snapshot can be megabytes.
    // biome-ignore lint/performance/noAwaitInLoops: bounded memory
    const [a, b] = await Promise.all([
      readSnapshot(path.join(baseDir, file)),
      readSnapshot(path.join(headDir, file)),
    ]);
    out.files++;
    out.entries += Object.keys(a).length;
    const diff = diffSnapshot(a, b);
    if (
      Object.keys(diff.changed).length ||
      diff.removed.length ||
      diff.added.length
    )
      out.pages.push({ file, ...parseSnapshotFile(file), ...diff });
  }
  out.groups = groupChanges(
    out.pages.map((p) => ({ page: p.file, changed: p.changed })),
    options.examples,
  );
  return out;
}
