import { existsSync, realpathSync, symlinkSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { $ } from "bun";
import type { Config } from "../core/config";
import { stylesheets, UsageError } from "./project";
import type { Sheet } from "./sources";

// Bump when the cached shape changes.
const CACHE_VERSION = 2;

/** Builds kept in the cache directory; the least recently used go first. */
const KEEP = 32;

const ENTRY_RE = /^(base|head)-.*\.json$/;
const TRAILING_SLASH_RE = /\/+$/;

const LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

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
    // The build needs the project's installed dependencies.
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

/** `config.inputs` as normalized paths relative to the project, if any. */
function inputPaths(config: Config): string[] | undefined {
  const raw = config.inputs;
  if (raw === undefined) return undefined;
  const paths = (typeof raw === "string" ? [raw] : raw).map((p) =>
    normalize(p).replace(TRAILING_SLASH_RE, ""),
  );
  for (const p of paths)
    if (!p || isAbsolute(p) || p === ".." || p.startsWith("../"))
      throw new UsageError(
        `inputs: ${JSON.stringify(p)} isn't a path inside the project`,
      );
  return paths.length > 0 ? paths : undefined;
}

/**
 * The git object ids of `paths` at `rev`: when two commits share them, they
 * build the same stylesheets. Undefined when any can't be named (a path the
 * commit lacks, or `rev` isn't in a git repository).
 */
async function treesAt(
  cwd: string,
  rev: string,
  paths: string[],
): Promise<string[] | undefined> {
  const r = await $`git rev-parse ${paths.map((p) => `${rev}:./${p}`)}`
    .cwd(cwd)
    .quiet()
    .nothrow();
  if (r.exitCode !== 0) return undefined;
  const ids = r.text().trim().split("\n");
  return ids.length === paths.length ? ids : undefined;
}

/** Whether the working tree's `paths` are what HEAD committed there. */
async function pristine(cwd: string, paths: string[]): Promise<boolean> {
  const r =
    await $`git status --porcelain --untracked-files=all -- ${paths.map((p) => `:(literal)${p}`)}`
      .cwd(cwd)
      .quiet()
      .nothrow();
  return r.exitCode === 0 && r.text().trim() === "";
}

/**
 * Everything besides the sources and the config file that a build depends on
 * and that doesn't live in `inputs`: the installed dependencies, as far as
 * the lockfile names them.
 */
async function toolchain(cwd: string, top: string): Promise<string[]> {
  const hashes: string[] = [];
  for (const dir of new Set([cwd, top]))
    for (const name of LOCKFILES) {
      const file = Bun.file(join(dir, name));
      // biome-ignore lint/performance/noAwaitInLoops: a few small files
      if (await file.exists())
        hashes.push(`${name}:${Bun.hash(await file.bytes())}`);
    }
  return hashes;
}

const cacheKey = (parts: unknown[]) =>
  Bun.hash(JSON.stringify([...parts, CACHE_VERSION])).toString(36);

async function readCached(file: string): Promise<Sheet[] | undefined> {
  if (!existsSync(file)) return undefined;
  try {
    const sheets = await Bun.file(file).json();
    const now = new Date();
    await utimes(file, now, now);
    return sheets;
  } catch {
    // A partial or corrupt entry builds again.
    return undefined;
  }
}

async function writeCached(dir: string, file: string, sheets: Sheet[]) {
  await mkdir(dir, { recursive: true });
  const partial = `${file}.${process.pid}.tmp`;
  await Bun.write(partial, JSON.stringify(sheets));
  await rename(partial, file);
  const kept = await Promise.all(
    (await readdir(dir))
      .filter((n) => ENTRY_RE.test(n))
      .map(async (n) => ({ n, used: (await stat(join(dir, n))).mtimeMs })),
  ).catch(() => []);
  const stale = kept.sort((a, b) => b.used - a.used).slice(KEEP);
  await Promise.all(stale.map(({ n }) => rm(join(dir, n), { force: true })));
}

/** Git couldn't write the inputs out; the caller checks out the commit whole. */
class Unextractable extends Error {}

/** Runs `fn` in a temporary directory holding only `paths` as of `sha`. */
async function inInputs<T>(
  cwd: string,
  top: string,
  sha: string,
  paths: string[],
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "crassus-base-"));
  const index = `${dir}.index`;
  try {
    const at = relative(realpathSync(top), realpathSync(cwd));
    if (at.startsWith("..")) throw new UsageError(`${cwd} is outside ${top}`);
    // A throwaway index, so the repository's own is left alone; the paths
    // are written as a checkout would (filters and all).
    const env = { ...process.env, GIT_INDEX_FILE: index };
    try {
      await $`git read-tree ${sha}`.cwd(top).env(env).quiet();
      await $`git ls-files -z --full-name -- ${paths.map((p) => `:(literal)${join(at, p)}`)} | git checkout-index -z --stdin --prefix=${`${dir}/`}`
        .cwd(top)
        .env(env)
        .quiet();
    } catch (e) {
      throw new Unextractable((e as Error).message);
    }
    const root = resolve(dir, at);
    for (const [from, to] of [
      [join(cwd, "node_modules"), join(root, "node_modules")],
      [join(top, "node_modules"), join(dir, "node_modules")],
    ])
      if (existsSync(from) && !existsSync(to)) symlinkSync(from, to, "dir");
    return await fn(root);
  } finally {
    await Promise.all([
      rm(dir, { recursive: true, force: true }),
      rm(index, { force: true }),
    ]);
  }
}

export async function atRef<T>(
  cwd: string,
  ref: string,
  fn: (root: string) => Promise<T>,
): Promise<{ sha: string; result: T }> {
  const { sha, top } = await resolveRef(cwd, ref);
  return { sha, result: await inCheckout(cwd, top, sha, fn) };
}

/** Where builds and indexes are cached for the project at `cwd`. */
export const cacheDir = (cwd: string) =>
  existsSync(join(cwd, "node_modules"))
    ? join(cwd, "node_modules/.cache/crassus")
    : join(tmpdir(), "crassus-cache");

const built = (ref: string, sha: string) => (e: unknown) => {
  if (e instanceof UsageError)
    throw new UsageError(
      `couldn't build the base ${ref} (${sha.slice(0, 9)}): ${e.message}`,
    );
  throw e;
};

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
  // With `inputs`, the commit is only a way to read them: what the build
  // depends on is their contents, so commits that left them alone share one.
  const paths = inputPaths(config);
  const trees = paths && (await treesAt(cwd, sha, paths));
  const key = cacheKey(
    trees
      ? [trees, paths, await toolchain(cwd, top), opts.configText, only]
      : [sha, opts.configText, only],
  );
  const dir = cacheDir(cwd);
  const file = join(dir, `base-${key}.json`);
  const hit = opts.cache ? await readCached(file) : undefined;
  if (hit) return { sha, sheets: hit, cached: true };
  const build = (root: string) => stylesheets(root, config, only);
  const sheets = await (paths && trees
    ? inInputs(cwd, top, sha, paths, build)
    : inCheckout(cwd, top, sha, build)
  ).catch(built(ref, sha));
  await writeCached(dir, file, sheets);
  return { sha, sheets, cached: false };
}

/**
 * The stylesheets of the working tree. With `inputs` that match HEAD's, they
 * are cached by those files' contents, like the base, so an unchanged
 * project doesn't build again.
 */
export async function headStylesheets(opts: {
  cwd: string;
  config: Config;
  configText: string;
  only: string[];
  cache: boolean;
}): Promise<{ sheets: Sheet[]; cached: boolean }> {
  const { cwd, config, only } = opts;
  const paths = opts.cache ? inputPaths(config) : undefined;
  const top = paths
    ? await $`git rev-parse --show-toplevel`.cwd(cwd).quiet().nothrow()
    : undefined;
  const trees =
    paths && top?.exitCode === 0 && (await pristine(cwd, paths))
      ? await treesAt(cwd, "HEAD", paths)
      : undefined;
  if (!(paths && top && trees))
    return { sheets: await stylesheets(cwd, config, only), cached: false };
  // The sheets name the project's own paths, so the key does too.
  const key = cacheKey([
    trees,
    paths,
    await toolchain(cwd, top.text().trim()),
    opts.configText,
    only,
    cwd,
  ]);
  const dir = cacheDir(cwd);
  const file = join(dir, `head-${key}.json`);
  const hit = await readCached(file);
  if (hit) return { sheets: hit, cached: true };
  const sheets = await stylesheets(cwd, config, only);
  await writeCached(dir, file, sheets);
  return { sheets, cached: false };
}
