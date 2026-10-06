/**
 * Shared setup for the evals that compare crassus against the original
 * tooling in a carbon-components-svelte checkout (`scripts/lib/css-*.ts`,
 * `e2e/cascade-*.ts`, `e2e/selector-stats.ts`).
 *
 *   CCS_ROOT=/path/to/carbon-components-svelte bun eval/carbon/parity.ts
 *
 * The checkout needs `bun install` and `bun run build:css`. Fixture pages
 * are built from its `e2e/fixtures` on first use.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { $ } from "bun";
import type { Rule } from "../../src/core/cascade";
import type { CascadeLib } from "../../src/core/diff";

const root = process.env.CCS_ROOT;
if (!root || !existsSync(path.join(root, "scripts/lib/css-cascade.ts"))) {
  console.error(
    "Set CCS_ROOT to a carbon-components-svelte checkout (with scripts/lib/css-cascade.ts).",
  );
  process.exit(2);
}

/** The carbon-components-svelte checkout. */
export const CCS_ROOT = path.resolve(root);

/** Scratch output (gitignored). */
export const EVAL_DIR = path.resolve(import.meta.dir, "../../.eval");

export const results = (...parts: string[]) => path.join(EVAL_DIR, ...parts);

export interface OldCascade extends CascadeLib {
  parseRules(css: string, positions?: boolean): Rule[];
}

export interface OldOverrides {
  deadDeclarations(
    css: string,
  ): { context: string; selector: string; property: string }[];
}

export const loadOldCascade = async (): Promise<OldCascade> =>
  import(path.join(CCS_ROOT, "scripts/lib/css-cascade.ts"));

export const loadOldOverrides = async (): Promise<OldOverrides> =>
  import(path.join(CCS_ROOT, "scripts/lib/css-overrides.ts"));

export const loadOldTargets = async (): Promise<{ targets: object }> =>
  import(path.join(CCS_ROOT, "scripts/lib/css-targets.ts"));

/** Static build of the checkout's e2e fixtures, built once. */
export async function fixturesDir(): Promise<string> {
  const dir = results("fixtures");
  if (!existsSync(path.join(dir, "button.html"))) {
    await mkdir(dir, { recursive: true });
    await $`bunx vite build --config e2e/vite.config.ts --outDir ${dir} --emptyOutDir`
      .cwd(CCS_ROOT)
      .quiet();
  }
  return dir;
}
