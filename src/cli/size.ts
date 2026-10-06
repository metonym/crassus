/**
 * Minified and compressed size of a stylesheet, as Bun minifies it. Close
 * to other minifiers in absolute terms, but without browser targets the
 * base -> head delta can drift: a trend, not a budget.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Size {
  min: number;
  gzip: number;
  zstd: number;
}

export async function sizeOf(css: string): Promise<Size> {
  const dir = await mkdtemp(join(tmpdir(), "crassus-size-"));
  try {
    const file = join(dir, "in.css");
    await Bun.write(file, css);
    const out = await Bun.build({ entrypoints: [file], minify: true });
    if (!out.success) throw new Error(out.logs.join("\n"));
    const min = new Uint8Array(await out.outputs[0].arrayBuffer());
    return {
      min: min.byteLength,
      gzip: Bun.gzipSync(min).byteLength,
      zstd: Bun.zstdCompressSync(min).byteLength,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
