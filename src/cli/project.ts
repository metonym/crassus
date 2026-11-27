import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Config, Stylesheets } from "../core/config";
import { messageOf } from "../core/util";
import { readStylesheet, type Sheet } from "./sources";

/** A mistake in how crassus was called or configured (exit code 2). */
export class UsageError extends Error {}

// A swap of two neighbours counts as one edit, since typos make them
// (`hlep` is one from `help`); plain Levenshtein would count two.
function distance(a: string, b: string): number {
  let before: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d = Math.min(d, (before[j - 2] ?? 0) + 1);
      row.push(d);
    }
    before = prev;
    prev = row;
  }
  return prev[b.length] ?? 0;
}

// The name in `names` nearest to `typed`, only when it's close enough
// to be the one meant: one edit in every three characters.
export function nearest(
  typed: string,
  names: Iterable<string>,
): string | undefined {
  const most = Math.max(1, Math.floor(typed.length / 3));
  let best: string | undefined;
  let bestDistance = most + 1;
  for (const name of names) {
    const d = distance(typed, name);
    if (d < bestDistance) {
      best = name;
      bestDistance = d;
    }
  }
  return best;
}

/** `file` as the project at `cwd` names it; absolute when it's outside. */
export function shownPath(cwd: string, file: string): string {
  const rel = relative(cwd, file);
  return rel.startsWith("..") ? resolve(cwd, file) : rel || ".";
}

export const isOneOf = <T extends string>(
  options: readonly T[],
  value: string,
): value is T => options.some((option) => option === value);

const CONFIG_FILES = [
  "crassus.config.ts",
  "crassus.config.js",
  "crassus.config.mjs",
];

export async function loadConfig(
  cwd: string,
  explicit?: string,
): Promise<{ config: Config; file?: string }> {
  const file = explicit
    ? resolve(cwd, explicit)
    : CONFIG_FILES.map((f) => resolve(cwd, f)).find(existsSync);
  if (!file) return { config: {} };
  if (!existsSync(file)) throw new UsageError(`config not found: ${explicit}`);
  const mod: unknown = await import(pathToFileURL(file).href);
  const exported: unknown =
    typeof mod === "object" && mod !== null
      ? (Reflect.get(mod, "default") ?? Reflect.get(mod, "config"))
      : undefined;
  const config = exported as Config | undefined;
  if (!config || typeof config !== "object")
    throw new UsageError(`${relative(cwd, file)} has no default export`);
  return { config, file };
}

/** Runs a configured build command in `root`; its output shows on failure. */
export async function build(command: string, root: string): Promise<void> {
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0)
    throw new UsageError(
      `build failed (${command}, exit ${code})\n${out}${err}`,
    );
}

const readSheet = async (
  name: string,
  path: string,
  root: string,
): Promise<Sheet> => ({
  name,
  ...(await readStylesheet(path)),
  root,
  file: relative(root, path),
});

export function filesAsSheets(cwd: string, files: string[]): Promise<Sheet[]> {
  return Promise.all(
    files.map(async (f) => {
      const path = resolve(cwd, f);
      if (!existsSync(path)) throw new UsageError(`no such file: ${f}`);
      return readSheet(f, path, cwd);
    }),
  );
}

const compiledSheets = (
  root: string,
  compiled: [string, Stylesheets[string]][],
): Sheet[] =>
  compiled.map(([name, s]) => ({
    name,
    css: s.css,
    map: s.map,
    mapDir: root,
    root,
  }));

const ERROR_PREFIX_RE = /^Error: /;

/**
 * The config's `compile`, its errors cut to a line: the message's first,
 * and its last (where a compiler like Sass says where it failed).
 */
async function compileWith(
  config: Config & { compile: NonNullable<Config["compile"]> },
  root: string,
  options?: { entries?: string[] },
) {
  try {
    return await config.compile(root, options);
  } catch (e) {
    if (e instanceof UsageError) throw e;
    // Paths as the project names them (a base builds in a temporary checkout).
    const lines = messageOf(e)
      .replaceAll(`${root}/`, "")
      .replace(ERROR_PREFIX_RE, "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const at = lines.length > 1 ? ` (${lines.at(-1)})` : "";
    throw new UsageError(`compile failed: ${lines[0] ?? "no message"}${at}`);
  }
}

async function configuredSheets(
  root: string,
  config: Config,
  only: string[] = [],
) {
  // Only the entries asked for: another may not build at an older ref.
  if (config.compile)
    return compiledSheets(
      root,
      Object.entries(
        await compileWith(
          { ...config, compile: config.compile },
          root,
          only.length ? { entries: only } : undefined,
        ),
      ),
    );
  if (!config.css)
    throw new UsageError(
      "no stylesheets: pass CSS files, or add a crassus.config.ts with `css` or `compile`",
    );
  if (config.build) await build(config.build, root);
  const named: [string, string][] =
    typeof config.css === "string"
      ? [[config.css, config.css]]
      : Array.isArray(config.css)
        ? config.css.map((p) => [p, p])
        : Object.entries(config.css);
  return Promise.all(
    named.map(([name, p]) => {
      const path = resolve(root, p);
      if (!existsSync(path))
        throw new UsageError(
          `${p} doesn't exist${config.build ? ` after \`${config.build}\`` : ""}`,
        );
      return readSheet(name, path, root);
    }),
  );
}

/**
 * What `dead --fix` proves against: the configured stylesheets
 * plus `fixEntries`.
 */
export async function fixStylesheets(
  root: string,
  config: Config,
): Promise<Sheet[]> {
  const sheets = await configuredSheets(root, config);
  const names = new Set(sheets.map((s) => s.name));
  const extra = (config.fixEntries ?? []).filter((n) => !names.has(n));
  if (extra.length === 0) return sheets;
  if (!config.compile)
    throw new UsageError(
      `fixEntries names ${extra.join(", ")}, which \`css\` doesn't list`,
    );
  const compiled = await compileWith(
    { ...config, compile: config.compile },
    root,
    { entries: extra },
  );
  const missing = extra.filter((n) => !compiled[n]);
  if (missing.length > 0)
    throw new UsageError(
      `compile(root, { entries }) didn't return ${missing.join(", ")}: compile the entries it's given`,
    );
  return [
    ...sheets,
    ...compiledSheets(
      root,
      extra.flatMap((n): [string, Stylesheets[string]][] => {
        const sheet = compiled[n];
        return sheet ? [[n, sheet]] : [];
      }),
    ),
  ];
}

/** The configured stylesheets at `root`, filtered to `only` when given. */
export async function stylesheets(
  root: string,
  config: Config,
  only: string[],
): Promise<Sheet[]> {
  const sheets = await configuredSheets(root, config, only);
  if (only.length === 0) return sheets;
  const unknown = only.filter((n) => !sheets.some((s) => s.name === n));
  if (unknown.length > 0)
    throw new UsageError(
      `unknown entry ${unknown.join(", ")} (have: ${sheets.map((s) => s.name).join(", ")})`,
    );
  return sheets.filter((s) => only.includes(s.name));
}
