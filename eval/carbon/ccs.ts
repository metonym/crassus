/**
 * Shared setup for the evals that compare crassus against the original
 * tooling in a carbon-components-svelte checkout (`scripts/lib/css-*.ts`,
 * `e2e/cascade-*.ts`, `e2e/selector-stats.ts`).
 *
 *   CCS_ROOT=/path/to/carbon-components-svelte bun eval/carbon/parity.ts
 *
 * The checkout needs `bun install` and `bun run build:css`. Fixture pages
 * are built from its `e2e/fixtures` on first use.
 *
 * carbon-components-svelte deleted `scripts/lib/css-{cascade,overrides}.ts`
 * when it moved onto crassus, and will delete `e2e/cascade-*.ts`. Evals that
 * compare against those need a checkout from before the move (see
 * CONTRIBUTING); the rest run against any checkout.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { $ } from "bun";
import type { Rule } from "../../src/core/cascade";
import type { CascadeLib } from "../../src/core/diff";

const root = process.env.CCS_ROOT;
if (
  !root ||
  !existsSync(path.join(root, "css/all.scss")) ||
  !existsSync(path.join(root, "e2e/vite.config.ts"))
) {
  console.error(
    "Set CCS_ROOT to a carbon-components-svelte checkout (with css/all.scss and e2e/vite.config.ts).",
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

/**
 * Absolute path of a file in the checkout that only exists before the crassus
 * migration; exits with a pointer to CONTRIBUTING when it's gone. `hint`
 * names a way to run the eval without it.
 */
export function oldTool(rel: string, hint?: string): string {
  const file = path.join(CCS_ROOT, rel);
  if (!existsSync(file)) {
    console.error(
      `${rel} is not in ${CCS_ROOT}: it was removed when carbon-components-svelte moved onto crassus. ` +
        'Point CCS_ROOT at a pre-migration checkout (CONTRIBUTING, "Evals against carbon-components-svelte")' +
        (hint ? `, or ${hint}.` : "."),
    );
    process.exit(2);
  }
  return file;
}

export const loadOldCascade = async (): Promise<OldCascade> =>
  import(oldTool("scripts/lib/css-cascade.ts"));

export const loadOldOverrides = async (): Promise<OldOverrides> =>
  import(oldTool("scripts/lib/css-overrides.ts"));

export const loadOldTargets = async (): Promise<{ targets: object }> =>
  import(path.join(CCS_ROOT, "scripts/lib/css-targets.ts"));

/**
 * Static build of the checkout's e2e fixtures, built once per checkout (evals
 * may switch between a pre- and post-migration one). Delete it after
 * `build:css` to pick up new CSS.
 */
export async function fixturesDir(): Promise<string> {
  const dir = results(
    "fixtures",
    `${path.basename(CCS_ROOT)}-${Bun.hash(CCS_ROOT).toString(36)}`,
  );
  if (!existsSync(path.join(dir, "button.html"))) {
    await mkdir(dir, { recursive: true });
    await $`bunx vite build --config e2e/vite.config.ts --outDir ${dir} --emptyOutDir`
      .cwd(CCS_ROOT)
      .quiet();
  }
  return dir;
}
