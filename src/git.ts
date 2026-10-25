// Bun-only: the project's stylesheets at a git ref, built the way the CLI
// builds a base for `diff --base` and cached the same way.

import { baseStylesheets, headStylesheets } from "./cli/baseline";
import { loadConfig } from "./cli/project";
import type { Sheet } from "./cli/sources";
import type { Stylesheets } from "./core/config";

export interface CompileAtOptions {
  /** The project directory. Default: the current directory. */
  cwd?: string;
  /** Config file, as `--config`. Default: `crassus.config.{ts,js,mjs}`. */
  config?: string;
  /** Only these stylesheets (as the config's `compile` is asked for them). */
  entries?: string[];
  /** Read and write the cache. Default `true`. */
  cache?: boolean;
}

export interface CompiledAt {
  sheets: Stylesheets;
  /** Answered from the cache, so nothing was built. */
  cached: boolean;
}

const named = (sheets: Sheet[]): Stylesheets =>
  Object.fromEntries(sheets.map((s) => [s.name, { css: s.css, map: s.map }]));

/**
 * The project's stylesheets at git `ref`, or at the working tree when `ref`
 * is `undefined`. Builds with the project's `crassus.config`, in a checkout
 * of just its `inputs` when it declares them, and caches the result under
 * `node_modules/.cache/crassus` by what those paths contain: any commit that
 * left them alone reuses it, and so does the working tree while they match
 * HEAD. Without `inputs` the ref is built in a full worktree and cached by
 * commit, and the working tree is built every time.
 */
export async function compileAt(
  ref: string | undefined,
  options: CompileAtOptions = {},
): Promise<CompiledAt> {
  const cwd = options.cwd ?? process.cwd();
  const { config, file } = await loadConfig(cwd, options.config);
  const side = {
    cwd,
    config,
    configText: file ? await Bun.file(file).text() : "",
    only: options.entries ?? [],
    cache: options.cache ?? true,
  };
  const { sheets, cached } =
    ref === undefined
      ? await headStylesheets(side)
      : await baseStylesheets({ ...side, ref });
  return { sheets: named(sheets), cached };
}
