/**
 * End-to-end cascade-diff parity on real history: compiles css/all.scss at
 * several base refs and at the working tree, then runs the check:css
 * analysis with the css-tree lib and with the zero-dep port.
 *
 *   CCS_ROOT=… bun eval/carbon/diff-parity.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { $ } from "bun";
import { initAsyncCompiler } from "sass-embedded";
// biome-ignore lint/performance/noNamespaceImport: comparing two libraries with identical export names
import * as newLib from "../../src/core/cascade";
import { diffWith, type Flip } from "../../src/core/diff";
import { CCS_ROOT, loadOldCascade, results } from "./ccs";

const oldLib = await loadOldCascade();

const root = CCS_ROOT;
const strip = (s: string) => s.replace(/[\s"'\\]+/g, "");

const SASS = {
  style: "expanded" as const,
  quietDeps: true,
  silenceDeprecations: [
    "import",
    "global-builtin",
    "color-functions",
    "if-function",
  ] as ("import" | "global-builtin" | "color-functions" | "if-function")[],
};

async function compile(cssDir: string): Promise<string> {
  const compiler = await initAsyncCompiler();
  try {
    const { css } = await compiler.compileAsync(path.join(cssDir, "all.scss"), {
      ...SASS,
      loadPaths: [path.join(cssDir, "vendor")],
    });
    return css;
  } finally {
    await compiler.dispose();
  }
}

async function compileRef(ref: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "spike-diff-"));
  try {
    const tar = await $`git -C ${root} archive ${ref} css`.arrayBuffer();
    await new Bun.Archive(tar).extract(dir);
    return await compile(path.join(dir, "css"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const cssCommits = (await $`git -C ${root} log --format=%h -- css`.text())
  .trim()
  .split("\n");
const refs = [
  ...[1, 5, 20, 60, 120].map((n) => ({
    label: `${n} css commits back`,
    ref: cssCommits[n],
  })),
  { label: "before cascade tooling (31a6ebd6b^)", ref: "31a6ebd6b^" },
].filter((r) => r.ref);

const head = await compile(path.join(root, "css"));
const flipKey = (f: Flip) =>
  `${strip(f.rule.selector)}|${strip(f.other.selector)}|${f.prop}|${f.before}>${f.after}`;

const summary: unknown[] = [];
for (const { label, ref } of refs) {
  // biome-ignore lint/performance/noAwaitInLoops: sequential by design (one operation per view, or ordered output)
  const base = await compileRef(ref);
  const t0 = Bun.nanoseconds();
  const oldBase = oldLib.parseRules(base, true);
  const oldHead = oldLib.parseRules(head, true);
  const t1 = Bun.nanoseconds();
  const oldDiff = diffWith(oldLib, oldBase, oldHead);
  const t2 = Bun.nanoseconds();
  const newBase = newLib.parseRules(base, true);
  const newHead = newLib.parseRules(head, true);
  const t3 = Bun.nanoseconds();
  const newDiff = diffWith(newLib, newBase, newHead);
  const t4 = Bun.nanoseconds();

  const counts = (d: typeof oldDiff) => ({
    removed: d.removed.length,
    added: d.added.length,
    rewrites: d.rewrites.size,
    newRules: d.newRules.length,
    dropped: d.dropped.length,
    contextMoves: d.contextMoves.size,
    moved: d.movedHead.size,
    flips: d.flips.length,
    moveFlips: d.moveFlips.length,
  });
  const co = counts(oldDiff);
  const cn = counts(newDiff);
  const oldFlips = new Set(
    [...oldDiff.flips, ...oldDiff.moveFlips].map(flipKey),
  );
  const newFlips = new Set(
    [...newDiff.flips, ...newDiff.moveFlips].map(flipKey),
  );
  const onlyOld = [...oldFlips].filter((k) => !newFlips.has(k));
  const onlyNew = [...newFlips].filter((k) => !oldFlips.has(k));
  const ms = (a: number, b: number) => ((b - a) / 1e6).toFixed(0);

  console.log(`\n## ${label} (${ref})`);
  console.log(
    `parse base+head: ${ms(t0, t1)} → ${ms(t2, t3)} ms   diff: ${ms(t1, t2)} → ${ms(t3, t4)} ms`,
  );
  for (const k of Object.keys(co) as (keyof typeof co)[]) {
    const mark = co[k] === cn[k] ? " " : "≠";
    console.log(
      `  ${mark} ${k.padEnd(13)} ${String(co[k]).padStart(6)} ${String(cn[k]).padStart(6)}`,
    );
  }
  console.log(
    `  flip identity: only old ${onlyOld.length}, only new ${onlyNew.length}`,
  );
  for (const k of onlyOld.slice(0, 5)) console.log(`    old: ${k}`);
  for (const k of onlyNew.slice(0, 5)) console.log(`    new: ${k}`);
  summary.push({ label, ref, old: co, new: cn, onlyOld, onlyNew });
}
await Bun.write(results("diff-parity.json"), JSON.stringify(summary, null, 2));
