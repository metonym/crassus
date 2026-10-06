/**
 * The base of a `diff`: the project's stylesheets at a git ref, built in a
 * temporary worktree with the project's own build, and cached by commit.
 */
import { existsSync, realpathSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { $ } from "bun";
import type { Config } from "../core/config";
import { stylesheets, UsageError } from "./project";
import type { Sheet } from "./sources";

/** The commit a ref names, and the repository's top directory. */
async function resolveRef(
  cwd: string,
  ref: string,
): Promise<{ sha: string; top: string }> {
  const top = await $`git rev-parse --show-toplevel`.cwd(cwd).quiet().nothrow();
  if (top.exitCode !== 0) throw new UsageError(`not a git repository: ${cwd}`);
  const sha = await $`git rev-parse --verify --quiet ${`${ref}^{commit}`}`
    .cwd(cwd)
    .quiet()
    .nothrow();
  if (sha.exitCode !== 0) throw new UsageError(`unknown git ref: ${ref}`);
  return { sha: sha.text().trim(), top: top.text().trim() };
}

/** Runs `fn` in a temporary detached worktree of `sha`, at `cwd`'s place in it. */
async function inCheckout<T>(
  cwd: string,
  top: string,
  sha: string,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "crassus-base-"));
  await $`git worktree add --detach --quiet ${dir} ${sha}`.cwd(top).quiet();
  try {
    // git reports real paths (/private/var/… on macOS, not /var/…).
    const at = relative(realpathSync(top), realpathSync(cwd));
    if (at.startsWith("..")) throw new UsageError(`${cwd} is outside ${top}`);
    const root = resolve(dir, at);
    // The project's build runs with its installed dependencies.
    for (const [from, to] of [
      [join(cwd, "node_modules"), join(root, "node_modules")],
      [join(top, "node_modules"), join(dir, "node_modules")],
    ])
      if (existsSync(from) && !existsSync(to)) symlinkSync(from, to, "dir");
    return await fn(root);
  } finally {
    await $`git worktree remove --force ${dir}`.cwd(top).quiet().nothrow();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The stylesheets at `ref`. Cached under node_modules/.cache/crassus by
 * commit, config and entries; `cache: false` rebuilds.
 */
export async function baseStylesheets(opts: {
  cwd: string;
  ref: string;
  config: Config;
  configText: string;
  only: string[];
  cache: boolean;
}): Promise<{ sha: string; sheets: Sheet[]; cached: boolean }> {
  const { cwd, ref, config, only } = opts;
  const { sha, top } = await resolveRef(cwd, ref);
  const key = Bun.hash(
    JSON.stringify([sha, opts.configText, only, CACHE_VERSION]),
  ).toString(36);
  const dir = existsSync(join(cwd, "node_modules"))
    ? join(cwd, "node_modules/.cache/crassus")
    : join(tmpdir(), "crassus-cache");
  const file = join(dir, `base-${key}.json`);
  if (opts.cache && existsSync(file))
    return { sha, sheets: await Bun.file(file).json(), cached: true };
  const sheets = await inCheckout(cwd, top, sha, (root) =>
    stylesheets(root, config, only),
  );
  await mkdir(dir, { recursive: true });
  await Bun.write(file, JSON.stringify(sheets));
  return { sha, sheets, cached: false };
}

// Bump when the cached shape changes.
const CACHE_VERSION = 1;
