/**
 * Stylesheets for the CLI: read from disk or compiled by the config, with
 * findings mapped back to their sources through the source map.
 */
import { existsSync } from "node:fs";
import { SourceMap } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceMapJson } from "../core/config";

/** A position in an authoring source, relative to the project root. */
export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

/** Compiled position (1-based line, 0-based column) -> source position. */
export type Locate = (loc?: {
  line: number;
  column: number;
}) => SourceLocation | undefined;

/** A stylesheet ready to analyze (serializable, for the base cache). */
export interface Sheet {
  name: string;
  css: string;
  map?: string | SourceMapJson;
  /** Directory relative map sources resolve against. */
  mapDir: string;
  /** Project root the sources are reported relative to. */
  root: string;
  /** The CSS file, relative to `root`, when the sheet was read from one. */
  file?: string;
}

const SOURCE_MAPPING_RE = /\/\*\s*[#@]\s*sourceMappingURL=([^\s*]+)\s*\*\/\s*$/;
const DATA_URL_RE = /^data:application\/json[^,]*?(;base64)?,(.*)$/s;

const noLocation: Locate = () => undefined;

/**
 * Locates through a source map. Sources become paths relative to `root`:
 * `file:` URLs as is, others against `mapDir` and the map's `sourceRoot`.
 */
function locator(
  map: string | SourceMapJson | undefined,
  mapDir: string,
  root: string,
): Locate {
  if (!map) return noLocation;
  const json: SourceMapJson = typeof map === "string" ? JSON.parse(map) : map;
  const sm = new SourceMap(json as ConstructorParameters<typeof SourceMap>[0]);
  const files = new Map<string, string>();
  const fileOf = (source: string) => {
    let file = files.get(source);
    if (file === undefined) {
      const abs = source.startsWith("file:")
        ? fileURLToPath(source)
        : isAbsolute(source)
          ? source
          : resolve(mapDir, json.sourceRoot ?? "", source);
      file = relative(root, abs);
      files.set(source, file);
    }
    return file;
  };
  return (loc) => {
    if (!loc) return undefined;
    const e = sm.findEntry(loc.line - 1, loc.column) as {
      originalSource?: string;
      originalLine?: number;
      originalColumn?: number;
    };
    if (!e?.originalSource) return undefined;
    return {
      file: fileOf(e.originalSource),
      line: (e.originalLine ?? 0) + 1,
      column: e.originalColumn ?? 0,
    };
  };
}

/** Reads a CSS file and its source map: `<file>.map`, or `sourceMappingURL`. */
export async function readStylesheet(file: string): Promise<{
  css: string;
  map?: string;
  mapDir: string;
}> {
  const css = await Bun.file(file).text();
  const url = SOURCE_MAPPING_RE.exec(css)?.[1];
  if (url) {
    const data = DATA_URL_RE.exec(url);
    if (data) {
      const map = data[1]
        ? Buffer.from(data[2], "base64").toString("utf8")
        : decodeURIComponent(data[2]);
      return { css, map, mapDir: dirname(file) };
    }
    const mapFile = resolve(dirname(file), decodeURIComponent(url));
    if (existsSync(mapFile))
      return {
        css,
        map: await Bun.file(mapFile).text(),
        mapDir: dirname(mapFile),
      };
  }
  const sibling = `${file}.map`;
  if (existsSync(sibling))
    return { css, map: await Bun.file(sibling).text(), mapDir: dirname(file) };
  return { css, mapDir: dirname(file) };
}

/** Source locations through the sheet's source map only. */
export const mappedLocator = (sheet: Sheet): Locate =>
  locator(sheet.map, sheet.mapDir, sheet.root);

/**
 * Source locations for a sheet's compiled positions; without a mapping,
 * the position in the CSS file itself.
 */
export function locateIn(sheet: Sheet): Locate {
  const mapped = mappedLocator(sheet);
  const { file } = sheet;
  if (!file) return mapped;
  return (loc) =>
    mapped(loc) ?? (loc && { file, line: loc.line, column: loc.column });
}
