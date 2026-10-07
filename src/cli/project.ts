/**
 * The project the CLI runs in: its config, and its stylesheets at a root
 * (the working tree, or a temporary checkout of the base).
 */
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Config } from "../core/config";
import { readStylesheet, type Sheet } from "./sources";

/** A mistake in how crassus was called or configured (exit code 2). */
export class UsageError extends Error {}

const CONFIG_FILES = [
  "crassus.config.ts",
  "crassus.config.js",
  "crassus.config.mjs",
];

/** Loads `crassus.config.*` from `cwd`, or the file given with `--config`. */
export async function loadConfig(
  cwd: string,
  explicit?: string,
): Promise<{ config: Config; file?: string }> {
  const file = explicit
    ? resolve(cwd, explicit)
    : CONFIG_FILES.map((f) => resolve(cwd, f)).find(existsSync);
  if (!file) return { config: {} };
  if (!existsSync(file)) throw new UsageError(`config not found: ${explicit}`);
  const mod = await import(pathToFileURL(file).href);
  const config = (mod.default ?? mod.config) as Config | undefined;
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

/** CSS files from the command line, named by their path. */
export function filesAsSheets(cwd: string, files: string[]): Promise<Sheet[]> {
  return Promise.all(
    files.map(async (f) => {
      const path = resolve(cwd, f);
      if (!existsSync(path)) throw new UsageError(`no such file: ${f}`);
      return {
        name: f,
        ...(await readStylesheet(path)),
        root: cwd,
        file: relative(cwd, path),
      };
    }),
  );
}

/** The configured stylesheets at `root`, filtered to `only` when given. */
export async function stylesheets(
  root: string,
  config: Config,
  only: string[],
): Promise<Sheet[]> {
  let sheets: Sheet[];
  if (config.compile) {
    const compiled = await config.compile(root);
    sheets = Object.entries(compiled).map(([name, s]) => ({
      name,
      css: s.css,
      map: s.map,
      mapDir: root,
      root,
    }));
  } else if (config.css) {
    if (config.build) await build(config.build, root);
    const named: [string, string][] =
      typeof config.css === "string"
        ? [[config.css, config.css]]
        : Array.isArray(config.css)
          ? config.css.map((p) => [p, p])
          : Object.entries(config.css);
    sheets = await Promise.all(
      named.map(async ([name, p]) => {
        const path = resolve(root, p);
        if (!existsSync(path))
          throw new UsageError(
            `${p} doesn't exist${config.build ? ` after \`${config.build}\`` : ""}`,
          );
        return {
          name,
          ...(await readStylesheet(path)),
          root,
          file: relative(root, path),
        };
      }),
    );
  } else {
    throw new UsageError(
      "no stylesheets: pass CSS files, or add a crassus.config.ts with `css` or `compile`",
    );
  }
  if (only.length === 0) return sheets;
  const unknown = only.filter((n) => !sheets.some((s) => s.name === n));
  if (unknown.length > 0)
    throw new UsageError(
      `unknown entry ${unknown.join(", ")} (have: ${sheets.map((s) => s.name).join(", ")})`,
    );
  return sheets.filter((s) => only.includes(s.name));
}
