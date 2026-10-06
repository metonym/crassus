/**
 * source-map-js vs node:module SourceMap (attribution), and lightningcss vs
 * Bun.build (minified size line).
 *
 *   CCS_ROOT=… bun eval/carbon/sourcemap-size.ts
 */

import { mkdtemp, rm } from "node:fs/promises";
import { SourceMap } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { $ } from "bun";
import { transform } from "lightningcss";
import { initAsyncCompiler } from "sass-embedded";
import { SourceMapConsumer } from "source-map-js";
import { parseRules } from "../../src/core/cascade";
import { CCS_ROOT, loadOldTargets } from "./ccs";

const { targets } = await loadOldTargets();

const root = CCS_ROOT;
const SASS = {
  quietDeps: true,
  silenceDeprecations: [
    "import",
    "global-builtin",
    "color-functions",
    "if-function",
  ] as ("import" | "global-builtin" | "color-functions" | "if-function")[],
};

async function compileAt(cssDir: string) {
  const compiler = await initAsyncCompiler();
  try {
    const entry = path.join(cssDir, "all.scss");
    const opts = { ...SASS, loadPaths: [path.join(cssDir, "vendor")] };
    const [expanded, compressed] = await Promise.all([
      compiler.compileAsync(entry, {
        ...opts,
        style: "expanded",
        sourceMap: true,
      }),
      compiler.compileAsync(entry, { ...opts, style: "compressed" }),
    ]);
    return { expanded, compressed: compressed.css };
  } finally {
    await compiler.dispose();
  }
}

// ---------------------------------------------------------------------------
// Source maps

const { expanded } = await compileAt(path.join(root, "css"));
const rules = parseRules(expanded.css, true);
const map = expanded.sourceMap as unknown as Record<string, unknown>;

let t = Bun.nanoseconds();
const consumer = new SourceMapConsumer(
  map as unknown as ConstructorParameters<typeof SourceMapConsumer>[0],
);
const oldOut = rules.map((r) => {
  const { source, line } = consumer.originalPositionFor(
    r.loc ?? { line: 1, column: 0 },
  );
  return source ? `${source}:${line}` : "?";
});
const oldMs = (Bun.nanoseconds() - t) / 1e6;

t = Bun.nanoseconds();
const sm = new SourceMap(
  map as unknown as ConstructorParameters<typeof SourceMap>[0],
);
const newOut = rules.map((r) => {
  const loc = r.loc ?? { line: 1, column: 0 };
  const e = sm.findEntry(loc.line - 1, loc.column) as {
    originalSource?: string;
    originalLine?: number;
  };
  return e?.originalSource
    ? `${e.originalSource}:${(e.originalLine ?? 0) + 1}`
    : "?";
});
const newMs = (Bun.nanoseconds() - t) / 1e6;

let same = 0;
const diffs: string[] = [];
oldOut.forEach((o, i) => {
  if (o === newOut[i]) same++;
  else if (diffs.length < 5)
    diffs.push(`${rules[i].selector}: ${o} vs ${newOut[i]}`);
});
console.log("## Source-map attribution (all.scss expanded)");
console.log(
  `${rules.length} rule lookups: source-map-js ${oldMs.toFixed(1)} ms, node:module SourceMap ${newMs.toFixed(1)} ms; agree ${same}/${rules.length}`,
);
for (const d of diffs) console.log(`  ${d}`);

// ---------------------------------------------------------------------------
// Minified size: lightningcss (browserslist targets) vs Bun.build

async function bunMinify(css: string): Promise<Uint8Array> {
  const dir = await mkdtemp(path.join(tmpdir(), "spike-min-"));
  try {
    const file = path.join(dir, "in.css");
    await Bun.write(file, css);
    const out = await Bun.build({ entrypoints: [file], minify: true });
    return new Uint8Array(await out.outputs[0].arrayBuffer());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function lcMinify(css: string): Uint8Array {
  return transform({
    filename: "all.css",
    code: Buffer.from(css, "utf8"),
    targets,
    minify: true,
  }).code;
}

async function compileRef(ref: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "spike-size-"));
  try {
    const tar = await $`git -C ${root} archive ${ref} css`.arrayBuffer();
    await new Bun.Archive(tar).extract(dir);
    return (await compileAt(path.join(dir, "css"))).compressed;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const headCss = (await compileAt(path.join(root, "css"))).compressed;
const baseCss = await compileRef("31a6ebd6b^");
console.log("\n## Minified size (base 31a6ebd6b^ → head)");
for (const [name, fn] of [
  ["lightningcss", async (c: string) => lcMinify(c)],
  ["Bun.build", bunMinify],
] as const) {
  const t0 = Bun.nanoseconds();
  // biome-ignore lint/performance/noAwaitInLoops: sequential by design (one operation per view, or ordered output)
  const b = await fn(baseCss);
  const h = await fn(headCss);
  const ms = (Bun.nanoseconds() - t0) / 2e6;
  const gz = (u: Uint8Array) =>
    Bun.gzipSync(u as Uint8Array<ArrayBuffer>).byteLength;
  console.log(
    `${name.padEnd(13)} min ${b.byteLength} → ${h.byteLength} (${h.byteLength - b.byteLength})` +
      `   gzip ${gz(b)} → ${gz(h)} (${gz(h) - gz(b)})   ~${ms.toFixed(0)} ms/entry`,
  );
}
