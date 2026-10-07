/**
 * Shared setup for the evals against a carbon-components-svelte checkout
 * (after `bun install` and `bun run build:css`); see CONTRIBUTING.
 *
 *   CCS_ROOT=/path/to/carbon-components-svelte bun eval/carbon/parity.ts
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { $ } from "bun";
import {
  type CompileResult,
  initAsyncCompiler,
  type Options,
} from "sass-embedded";
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

export const CCS_ROOT = path.resolve(root);

/** Scratch output under .eval/ (gitignored). */
export const results = (...parts: string[]) =>
  path.join(import.meta.dir, "../../.eval", ...parts);

/** Playwright's Chromium, so Bun.WebView runs the same build as the old tools. */
export const PLAYWRIGHT_SHELL = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

export const args = process.argv.slice(2);

export const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

export const loadAvg = () =>
  loadavg()
    .map((x) => x.toFixed(1))
    .join(" ");

/** Formatting-insensitive: whitespace, quote style and escapes. */
export const strip = (s: string) => s.replace(/[\s"'\\]+/g, "");

interface OldCascade extends CascadeLib {
  parseRules(css: string, positions?: boolean): Rule[];
}

interface OldOverrides {
  deadDeclarations(
    css: string,
  ): { context: string; selector: string; property: string }[];
}

/**
 * A file carbon-components-svelte removed when it moved onto crassus; exits
 * with a pointer to CONTRIBUTING when it's gone. `hint` names a way around it.
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

/** Compiles `<cssDir>/<entry>.scss` as the checkout's build does. */
export async function withSass<T>(
  fn: (
    compile: (
      cssDir: string,
      entry: string,
      opts: Options<"async">,
    ) => Promise<CompileResult>,
  ) => Promise<T>,
): Promise<T> {
  const compiler = await initAsyncCompiler();
  try {
    return await fn((cssDir, entry, opts) =>
      compiler.compileAsync(path.join(cssDir, `${entry}.scss`), {
        ...opts,
        loadPaths: [path.join(cssDir, "vendor")],
        quietDeps: true,
        silenceDeprecations: [
          "import",
          "global-builtin",
          "color-functions",
          "if-function",
        ],
      }),
    );
  } finally {
    await compiler.dispose();
  }
}

/** Runs `fn` on the checkout's `css/` as of `ref`, extracted to a temp dir. */
export async function atRef<T>(
  ref: string,
  fn: (cssDir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "ccs-ref-"));
  try {
    const tar = await $`git -C ${CCS_ROOT} archive ${ref} css`.arrayBuffer();
    await new Bun.Archive(tar).extract(dir);
    return await fn(path.join(dir, "css"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const fixtureNames = async (only?: string) =>
  (await readdir(path.join(CCS_ROOT, "e2e/fixtures")))
    .filter((f) => f.endsWith(".html"))
    .map((f) => f.slice(0, -".html".length))
    .filter((f) => !only || f.includes(only))
    .sort();

/**
 * Static build of the checkout's e2e fixtures, keyed by checkout (evals may
 * switch between a pre- and post-migration one). Delete it after `build:css`
 * to pick up new CSS.
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
