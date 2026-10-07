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
   * project, or a temporary checkout of the base for `diff`. With
   * `entries`, compile those (`dead --fix` asks for `fixEntries`).
   */
  compile?: (
    root: string,
    options?: { entries?: string[] },
  ) => Stylesheets | Promise<Stylesheets>;
  /**
   * `dead --fix`: more entries to prove fixes against, beside the ones
   * `compile` builds by default. A source shared with entries you don't
   * analyze (a Sass partial every theme imports) is only proved dead for
   * the ones you do, so list every entry that imports it.
   */
  fixEntries?: string[];
  /**
   * The component a class belongs to (`bx--btn--primary` -> `btn`). `diff`
   * only pairs a moved rule with rules of its own component. Default: the
   * class with a leading `prefix--` removed, cut at the first `__` or `--`.
   */
  componentOf?: (className: string) => string;
  /** Fixture pages for `capture` and `usage` (rungs 2 and 3). */
  browser?: BrowserConfig;
}

/**
 * Real-browser runs. Each `.html` file in the fixture directory is a page,
 * loaded once per theme and viewport. Command-line flags override these.
 */
export interface BrowserConfig {
  /**
   * The fixture directory (relative to the project root), or that and the
   * shell command that writes it. `build` runs first, in the project, or in
   * the base checkout for `capture --base`.
   */
  fixtures: string | { dir: string; build?: string };
  /** Themes to load each page in. Default: one run, with no theme attribute. */
  themes?: string[];
  /** The `<html>` attribute a theme is set as, before first paint. Default `theme`. */
  themeAttribute?: string;
  /** Text only the library stylesheet contains (a class prefix): `usage` needs it. */
  sheetMarker?: string;
  /** Default: 1280 × 900. Cover your `min-width`/`max-width` breakpoints. */
  viewports?: { width: number; height: number }[];
  /** Wait after load until this selector matches (a page that never does is reported). */
  readySelector?: string;
  /** Default 5000. */
  readyTimeoutMs?: number;
  /** `capture`: wait this long after load (and readiness). Default 500. */
  settleMs?: number;
  /** Default `chrome`. `webkit` is the system WebKit (macOS). */
  engine?: "chrome" | "webkit";
  /** Tabs in parallel. Default 8. */
  concurrency?: number;
  /** Chrome or Chromium binary. Default: auto-detected. */
  chromePath?: string;
}

/** Types a `crassus.config.ts`. */
export function defineConfig(config: Config): Config {
  return config;
}
