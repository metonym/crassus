// Bun macro: inlines src/page/usage-dom.ts as a minified IIFE, so dist/ needs
// no page sources. A subprocess, as `Bun.build` deadlocks inside a macro.
import path from "node:path";

const TRAILING_SEMICOLON_RE = /;\s*$/;

export function usageDomScript(): string {
  const entry = path.join(import.meta.dir, "../page/usage-dom.ts");
  const result = Bun.spawnSync([
    process.execPath,
    "build",
    entry,
    "--target=browser",
    "--format=iife",
    "--minify",
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`page bundle failed:\n${result.stderr.toString()}`);
  }
  // evaluate() takes an expression: drop the statement terminator.
  return result.stdout.toString().trim().replace(TRAILING_SEMICOLON_RE, "");
}
