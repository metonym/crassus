import path from "node:path";
import {
  type ChangedSelector,
  changedRules,
  impactProperties,
} from "../core/impact";
import {
  diffSnapshot,
  diffTokens,
  type Explained,
  type Inspected,
  type PageDiff,
  type Where,
} from "../core/snapshot-diff";
import { inspectPage, type PageInspection, type Shot } from "./inspect";
import { matchPages, pageIndex } from "./page-index";
import { crop, decodePng, difference, type Image } from "./png";
import { serveFixtures, swappedSheet } from "./serve";
import {
  type CaptureOptions,
  capturePage,
  type PageScope,
  preparePage,
  snapshotFile,
  tagStates,
} from "./snapshot";
import { type SnapshotDiff, summarizePages } from "./snapshot-diff";
import {
  loadPage,
  type PageJob,
  pageJobs,
  View,
  viewportsOf,
  visitPages,
} from "./view";

export interface CompareOptions
  extends Omit<CaptureOptions, "baseUrl" | "outDir"> {
  /** The fixture directory, served once per side. */
  dir: string;
  /** Text only the library stylesheet contains: the file `base` and `head` replace. */
  sheetMarker: string;
  /** The library stylesheet's CSS on each side. */
  base: string;
  head: string;
  /** Example paths per group. Default 3. */
  examples?: number;
  /** Chrome: the declaration that won each changed property, on each side. */
  explain?: boolean;
  /** Chrome: screenshot each changed element on each side, and compare. */
  visual?: boolean;
  /**
   * Default true: load only the pages the changed rules can reach, and read
   * only what they can change there (see `Impact`). False reads everything.
   */
  scope?: boolean;
  /** Where to keep the page index `scope` builds, between runs. */
  indexDir?: string;
  /** Called with the change's reach, before any page is captured. */
  onImpact?: (impact: Impact) => void;
  /** Keep what a report needs: changed elements' markup, and with `visual`, their crops. */
  report?: boolean;
  /**
   * Trace what design tokens (custom properties with this prefix, like
   * `--cds-`) drive each property on both sides, and report properties
   * that stop following one (`PageDiff.tokens`). Unforced states only.
   */
  tokens?: string;
}

/** An element's crops on each side, kept for a report: `crops[page][path]`. */
export type Crops = Record<
  string,
  Record<string, { base: Image; head: Image }>
>;

/** What a stylesheet change can reach on the fixtures. */
export interface Impact {
  /** Pages (fixture × theme × viewport) in all. */
  total: number;
  /** Pages a changed rule's selector matches: the only ones captured. */
  pages: number;
  /** Elements those selectors match on them, before descendants. */
  elements: number;
  /** Distinct selectors of changed rules, states and pseudo-elements dropped. */
  selectors: number;
  /** Why every page and element was read, when they were. */
  everything?: string;
  /** Built this run, or read from `indexDir`. */
  index?: "built" | "cached";
}

interface Plan {
  /** Longhands either stylesheet declares. */
  declared: string[];
  /** Every longhand the engine computes. */
  longhands: string[];
  /** A written property -> the longhands it sets. */
  expands: Record<string, string[]>;
  /** The changed selectors the engine can run (or whose rules it applies). */
  selectors: ChangedSelector[];
}

/**
 * What the engine makes of the stylesheets: the longhands they declare (as
 * the CSSOM expands them), what each changed property sets, and which
 * relaxed selectors it parses. A selector it rejects is kept when the
 * engine applies one of its rules: pages then can't be skipped.
 */
async function planIn(
  opts: Pick<CompareOptions, "engine" | "chromePath">,
  sheets: string[],
  changed: ChangedSelector[],
): Promise<Plan> {
  const view = new View({ engine: opts.engine, chromePath: opts.chromePath });
  try {
    await view.navigate("about:blank");
    const props = [...new Set(changed.flatMap((c) => c.properties))];
    const { keep, ...rest } = await view.evaluate<
      Omit<Plan, "selectors"> & { keep: boolean[] }
    >(`((texts, props, selectors) => {
      const out = new Set();
      const visit = (list) => {
        for (const rule of list) {
          if (rule.style) for (let i = 0; i < rule.style.length; i++) {
            if (!rule.style[i].startsWith("--")) out.add(rule.style[i]);
          }
          if (rule.cssRules) visit(rule.cssRules);
        }
      };
      for (const text of texts) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(text);
        visit(sheet.cssRules);
      }
      const style = document.createElement("div").style;
      const expands = {};
      for (const p of props) {
        style.cssText = "";
        style.setProperty(p, "initial");
        expands[p] = Array.from(style);
      }
      const applies = (s) => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(s + "{}");
        return sheet.cssRules.length > 0;
      };
      const keep = selectors.map(([relaxed, sources]) => {
        try { document.querySelectorAll(relaxed); return true; } catch { return sources.some(applies); }
      });
      return {
        declared: [...out].sort(),
        longhands: Array.from(getComputedStyle(document.documentElement)),
        expands,
        keep,
      };
    })(${JSON.stringify(sheets)}, ${JSON.stringify(props)}, ${JSON.stringify(changed.map((c) => [c.selector, c.sources]))})`);
    return { ...rest, selectors: changed.filter((_, i) => keep[i]) };
  } finally {
    view.close();
  }
}

/**
 * Captures every fixture page with the library stylesheet replaced by `base`,
 * then by `head`, in the same tab, and diffs them page by page: the DOM is
 * the same on both sides, and no snapshot is kept. Both sides record every
 * property either stylesheet declares, so nothing is left uncompared.
 *
 * With `scope` (the default), the rules that differ decide what's read: a
 * page none of their selectors match (states and pseudo-elements dropped)
 * isn't loaded, as its styles can't change, and on the others only the
 * elements they match, with their descendants and ancestors, are read,
 * for the properties those rules can move. When a box can move, every
 * element is read for the values that hang on layout. The pages' DOM comes
 * from an index recorded once per fixture build (`indexDir`).
 */
export async function compareCss(opts: CompareOptions): Promise<
  SnapshotDiff & {
    ms: number;
    notReady: string[];
    /** The fixture file both sides replaced, relative to `dir`: `Winner.sheet` for its rules. */
    library: string;
    impact: Impact;
    /** With `report` and `visual`. */
    crops?: Crops;
  }
> {
  if ((opts.explain || opts.visual) && opts.engine !== "chrome")
    throw new Error("explain and visual need Chrome (CDP)");
  const started = performance.now();
  const rules = changedRules(opts.base, opts.head);
  const changes = opts.scope === false ? null : rules;
  const library = swappedSheet(opts.dir, opts.sheetMarker)
    .split(path.sep)
    .join("/");
  const crops: Crops | undefined = opts.report && opts.visual ? {} : undefined;
  const plan = await planIn(
    opts,
    [opts.base, opts.head],
    changes?.selectors ?? [],
  );
  const swap = (css: string) =>
    serveFixtures(opts.dir, { swap: { marker: opts.sheetMarker, css } });
  const viewports = viewportsOf(opts);
  const several = viewports.length > 1;
  const pageFile = (job: PageJob) =>
    snapshotFile(job, several).replace(".json.gz", "");
  const jobs = pageJobs(
    "",
    opts.fixtures,
    opts.themes,
    viewports,
    opts.themeAttribute,
  );
  const impact: Impact = {
    total: jobs.length,
    pages: jobs.length,
    elements: 0,
    selectors: changes?.selectors.length ?? 0,
  };
  if (!changes) impact.everything = "scope is off";
  else if (changes.everything) impact.everything = changes.everything;

  let hit: Set<string> | null = null;
  const skippedNotReady: string[] = [];
  const selectors = plan.selectors.map((c) => c.selector);
  if (!impact.everything) {
    const built = await pageIndex({ ...opts, cacheDir: opts.indexDir });
    impact.index = built.cached ? "cached" : "built";
    const matches = await matchPages(built.index, jobs, selectors, opts);
    hit = new Set();
    impact.pages = 0;
    for (const job of jobs) {
      const m = matches.get(job.label);
      if (m && (m.all || m.hits.length > 0)) {
        hit.add(job.label);
        impact.pages++;
        impact.elements += m.elements;
      } else if (built.index.pages[job.label]?.ready === false)
        skippedNotReady.push(job.label);
    }
  }
  opts.onImpact?.(impact);

  const scopeFor = (): PageScope | undefined => {
    if (!hit) return undefined;
    let planned: ReturnType<PageScope["plan"]> | undefined;
    return {
      selectors,
      // The base side plans; the head side reads the same.
      plan(hits) {
        if (planned) return planned;
        const written = new Set(
          hits.flatMap((i) => plan.selectors[i].properties),
        );
        const longhands = [...written].flatMap((p) => plan.expands[p] ?? []);
        const p = impactProperties(longhands, plan.longhands);
        planned =
          changes?.containers && (p.layout || p.properties === null)
            ? { properties: null, layout: true }
            : p;
        return planned;
      },
    };
  };

  const base = swap(opts.base);
  const head = swap(opts.head);
  const pages: { file: string; diff: PageDiff & Inspected; entries: number }[] =
    [];
  const headNotReady: string[] = [];
  try {
    const r = await visitPages(
      {
        ...opts,
        baseUrl: base.url,
        ...(hit && { only: (job) => hit.has(job.label) }),
      },
      async (view, job) => {
        const scope = scopeFor();
        const a = await capturePage(view, opts, plan.declared, scope);
        if (
          !(await loadPage(
            view,
            head.url + job.url.slice(base.url.length),
            opts,
          ))
        )
          headNotReady.push(job.label);
        const b = await capturePage(view, opts, plan.declared, scope);
        const diff: PageDiff & Inspected = diffSnapshot(a.snapshot, b.snapshot);
        if (a.tokens && b.tokens) {
          const tokens = diffTokens(a.tokens, b.tokens, b.snapshot);
          if (Object.keys(tokens).length) diff.tokens = tokens;
        }
        const file = snapshotFile(job, several).replace(".json.gz", "");
        const keys = Object.keys(diff.changed);
        if (keys.length) {
          const found = await view.evaluate<(Where | null)[]>(
            `window.__cr.where(${JSON.stringify(keys)}, ${Boolean(opts.report)})`,
          );
          const where: Record<string, Where> = {};
          keys.forEach((k, i) => {
            const w = found[i];
            if (w) where[k] = w;
          });
          diff.where = where;
        }
        if ((opts.explain || opts.visual) && keys.length) {
          // Head is loaded; base is loaded again, prepared the same way.
          const after = await inspectPage(view, diff.changed, opts);
          await loadPage(view, job.url, opts);
          await preparePage(view, opts, plan.declared);
          if (opts.states) await tagStates(view);
          const before = await inspectPage(
            view,
            diff.changed,
            opts,
            after.batches,
          );
          if (crops) crops[file] = {};
          Object.assign(diff, combine(before, after, crops?.[file]));
          if (diff.explain) markChanged(diff.explain, library, rules.locations);
        }
        pages.push({
          file,
          diff,
          entries: Object.keys(a.snapshot).length,
        });
      },
    );
    // Pages no changed rule reaches compare equal, unread.
    if (hit)
      for (const job of jobs)
        if (!hit.has(job.label))
          pages.push({
            file: pageFile(job),
            diff: {
              changed: {},
              removed: [],
              added: [],
              uncompared: { onlyBase: [], onlyHead: [] },
            },
            entries: 0,
          });
    pages.sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0));
    return {
      ...summarizePages(pages, [], [], opts.examples),
      ms: performance.now() - started,
      library,
      ...(crops && { crops }),
      notReady: [
        ...new Set([...r.notReady, ...headNotReady, ...skippedNotReady]),
      ],
      impact,
    };
  } finally {
    base.stop();
    head.stop();
  }
}

/** Flags winners that are rules the two stylesheets differ in. */
function markChanged(
  explain: NonNullable<Inspected["explain"]>,
  library: string,
  locations: { base: Set<string>; head: Set<string> },
) {
  for (const props of Object.values(explain))
    for (const e of Object.values(props))
      for (const side of ["base", "head"] as const) {
        const w = e[side];
        if (
          w?.sheet === library &&
          locations[side].has(`${w.line}:${w.column ?? 0}`)
        )
          w.changed = true;
      }
}

function combine(
  before: PageInspection,
  after: PageInspection,
  /** Fills in each compared element's crops. */
  kept?: Crops[string],
): Inspected {
  const out: Inspected = {};
  if (before.explain && after.explain) {
    out.explain = {};
    for (const [path, props] of Object.entries(after.explain)) {
      const was = before.explain[path] ?? {};
      out.explain[path] = Object.fromEntries(
        Object.entries(props).map(([p, head]): [string, Explained] => [
          p,
          { base: was[p] ?? null, head },
        ]),
      );
    }
  }
  if (before.shots && after.shots) {
    out.pixels = {};
    out.deltaE = {};
    const crops = (shots: Shot[]) => {
      const images = new Map<Shot, Image>();
      const at = new Map<string, () => Image | null>();
      for (const shot of shots)
        for (const [path, box] of Object.entries(shot.boxes))
          at.set(path, () => {
            if (!box) return null;
            let image = images.get(shot);
            if (!image) {
              image = decodePng(shot.png);
              images.set(shot, image);
            }
            return crop(
              image,
              box.x - shot.clip.x,
              box.y - shot.clip.y,
              box.width,
              box.height,
            );
          });
      return at;
    };
    const [was, now] = [crops(before.shots), crops(after.shots)];
    for (const [path, get] of now) {
      const other = was.get(path);
      if (!other) continue;
      const [a, b] = [other(), get()];
      if (kept && a && b) kept[path] = { base: a, head: b };
      if (!a || !b || a.width !== b.width || a.height !== b.height) {
        // No box on either side is the same nothing; a new size differs.
        out.pixels[path] = Boolean(a || b);
        continue;
      }
      const d = difference(a, b);
      out.pixels[path] = d !== null;
      if (d) out.deltaE[path] = { max: d.max, mean: d.mean };
    }
  }
  return out;
}
