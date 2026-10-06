/**
 * `crassus.config.ts` shape. The CLI loads it; core only defines it, so
 * `defineConfig` is importable anywhere.
 */

/** A source map (v3), as JSON text or parsed. */
export interface SourceMapJson {
  version: number;
  sources: string[];
  sourceRoot?: string;
  mappings: string;
  names?: string[];
  sourcesContent?: (string | null)[];
  file?: string;
}

/** A compiled stylesheet and, for attribution to its sources, its source map. */
interface Stylesheet {
  css: string;
  /** Sources may be `file:` URLs or paths relative to the map's directory. */
  map?: string | SourceMapJson;
}

/** Stylesheets by name (`all`, `white`): reports group findings by it. */
export type Stylesheets = Record<string, Stylesheet>;

export interface Config {
  /**
   * Built CSS files, relative to the project root: one, several, or by
   * name. A sibling `.map` (or a `sourceMappingURL` comment) attributes
   * findings to their sources.
   */
  css?: string | string[] | Record<string, string>;
  /** Shell command that writes `css`. Runs in the project, and in a temporary checkout of the base for `diff`. */
  build?: string;
  /**
   * Instead of `css` and `build`: compile in-process. `root` is the
   * project, or a temporary checkout of the base for `diff`.
   */
  compile?: (root: string) => Stylesheets | Promise<Stylesheets>;
  /**
   * The component a class belongs to (`bx--btn--primary` -> `btn`). `diff`
   * only pairs a moved rule with rules of its own component. Default: the
   * class with a leading `prefix--` removed, cut at the first `__` or `--`.
   */
  componentOf?: (className: string) => string;
}

/** Types a `crassus.config.ts`. */
export function defineConfig(config: Config): Config {
  return config;
}
