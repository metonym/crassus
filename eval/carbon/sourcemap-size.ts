/**
 * source-map-js vs node:module SourceMap (attribution), and lightningcss vs
 * Bun.build (minified size line).
 *
 *   CCS_ROOT=… bun eval/carbon/sourcemap-size.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import {
  SourceMap,
  type SourceMapPayload,
  type SourceMapping,
} from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { transform } from "lightningcss";
import { SourceMapConsumer } from "source-map-js";
import { parseRules } from "../../src/core/cascade";
import { atRef, CCS_ROOT, loadOldTargets, withSass } from "./ccs";

const { targets } = await loadOldTargets();

const compileAt = (cssDir: string) =>
  withSass(async (compile) => {
    const [expanded, compressed] = await Promise.all([
      compile(cssDir, "all", { style: "expanded", sourceMap: true }),
      compile(cssDir, "all", { style: "compressed" }),
    ]);
    return { expanded, compressed: compressed.css };
  });

const head = await compileAt(path.join(CCS_ROOT, "css"));
const rules = parseRules(head.expanded.css, true);
const map = head.expanded.sourceMap;
if (!map) throw new Error("sass returned no source map");

let t = Bun.nanoseconds();
const consumer = new SourceMapConsumer(map);
const oldOut = rules.map((r) => {
  const { source, line } = consumer.originalPositionFor(
    r.loc ?? { line: 1, column: 0 },
  );
  return source ? `${source}:${line}` : "?";
});
const oldMs = (Bun.nanoseconds() - t) / 1e6;

t = Bun.nanoseconds();
const sm = new SourceMap(map as unknown as SourceMapPayload);
const newOut = rules.map((r) => {
  const loc = r.loc ?? { line: 1, column: 0 };
  const e: Partial<SourceMapping> = sm.findEntry(loc.line - 1, loc.column);
  return e.originalSource
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

const lcMinify = async (css: string): Promise<Uint8Array> =>
  transform({
    filename: "all.css",
    code: Buffer.from(css, "utf8"),
    targets,
    minify: true,
  }).code;

const gz = (u: Uint8Array) =>
  Bun.gzipSync(u as Uint8Array<ArrayBuffer>).byteLength;

const baseCss = await atRef(
  "31a6ebd6b^",
  async (dir) => (await compileAt(dir)).compressed,
);
console.log("\n## Minified size (base 31a6ebd6b^ → head)");
for (const [name, fn] of [
  ["lightningcss", lcMinify],
  ["Bun.build", bunMinify],
] as const) {
  const t0 = Bun.nanoseconds();
  // biome-ignore lint/performance/noAwaitInLoops: timed one at a time
  const b = await fn(baseCss);
  const h = await fn(head.compressed);
  const ms = (Bun.nanoseconds() - t0) / 2e6;
  console.log(
    `${name.padEnd(13)} min ${b.byteLength} → ${h.byteLength} (${h.byteLength - b.byteLength})` +
      `   gzip ${gz(b)} → ${gz(h)} (${gz(h) - gz(b)})   ~${ms.toFixed(0)} ms/entry`,
  );
}
