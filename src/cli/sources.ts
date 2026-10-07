import { existsSync } from "node:fs";
import { SourceMap } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceMapJson } from "../core/config";

export interface SourceLocation {
  /** Relative to the project root. */
  file: string;
  line: number;
  column: number;
}

/** Compiled position (1-based line, 0-based column) -> source position. */
export type Locate = (loc?: {
  line: number;
  column: number;
}) => SourceLocation | undefined;

/** Serializable, for the base cache. */
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
    const e = sm.findEntry(loc.line - 1, loc.column);
    if (!("originalSource" in e && e.originalSource)) return undefined;
    return {
      file: fileOf(e.originalSource),
      line: e.originalLine + 1,
      column: e.originalColumn,
    };
  };
}

/** Reads a CSS file and its source map: `sourceMappingURL`, else `<file>.map`. */
export async function readStylesheet(file: string): Promise<{
  css: string;
  map?: string;
  mapDir: string;
}> {
  const css = await Bun.file(file).text();
  const mapDir = dirname(file);
  const url = SOURCE_MAPPING_RE.exec(css)?.[1];
  if (url) {
    const data = DATA_URL_RE.exec(url);
    if (data) {
      const map = data[1]
        ? Buffer.from(data[2], "base64").toString("utf8")
        : decodeURIComponent(data[2]);
      return { css, map, mapDir };
    }
    const mapFile = resolve(mapDir, decodeURIComponent(url));
    if (existsSync(mapFile))
      return {
        css,
        map: await Bun.file(mapFile).text(),
        mapDir: dirname(mapFile),
      };
  }
  const sibling = `${file}.map`;
  if (existsSync(sibling))
    return { css, map: await Bun.file(sibling).text(), mapDir };
  return { css, mapDir };
}

/** Through the source map only; `locateIn` falls back to the CSS file. */
export const mappedLocator = (sheet: Sheet): Locate =>
  locator(sheet.map, sheet.mapDir, sheet.root);

export function locateIn(sheet: Sheet): Locate {
  const mapped = mappedLocator(sheet);
  const { file } = sheet;
  if (!file) return mapped;
  return (loc) =>
    mapped(loc) ?? (loc && { file, line: loc.line, column: loc.column });
}
