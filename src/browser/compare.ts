import path from "node:path";
import {
  diffSnapshot,
  type Explained,
  type Inspected,
  type PageDiff,
} from "../core/snapshot-diff";
import { inspectPage, type PageInspection } from "./inspect";
import { serveFixtures, swappedSheet } from "./serve";
import {
  type CaptureOptions,
  capturePage,
  preparePage,
  snapshotFile,
  tagStates,
} from "./snapshot";
import { type SnapshotDiff, summarizePages } from "./snapshot-diff";
import { loadPage, View, viewportsOf, visitPages } from "./view";

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
}

/** The longhands a stylesheet's rules declare, as the CSSOM expands them. */
async function declaredIn(
  opts: Pick<CompareOptions, "engine" | "chromePath">,
  sheets: string[],
): Promise<string[]> {
  const view = new View({ engine: opts.engine, chromePath: opts.chromePath });
  try {
    await view.navigate("about:blank");
    return await view.evaluate<string[]>(`((texts) => {
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
      return [...out].sort();
    })(${JSON.stringify(sheets)})`);
  } finally {
    view.close();
  }
}

/**
 * Captures every fixture page with the library stylesheet replaced by `base`,
 * then by `head`, in the same tab, and diffs them page by page: the DOM is
 * the same on both sides, and no snapshot is kept. Both sides record every
 * property either stylesheet declares, so nothing is left uncompared.
 */
export async function compareCss(opts: CompareOptions): Promise<
  SnapshotDiff & {
    ms: number;
    notReady: string[];
    /** The fixture file both sides replaced, relative to `dir`: `Winner.sheet` for its rules. */
    library: string;
  }
> {
  if ((opts.explain || opts.visual) && opts.engine !== "chrome")
    throw new Error("explain and visual need Chrome (CDP)");
  const extra = await declaredIn(opts, [opts.base, opts.head]);
  const swap = (css: string) =>
    serveFixtures(opts.dir, { swap: { marker: opts.sheetMarker, css } });
  const base = swap(opts.base);
  const head = swap(opts.head);
  const several = viewportsOf(opts).length > 1;
  const pages: { file: string; diff: PageDiff & Inspected; entries: number }[] =
    [];
  const headNotReady: string[] = [];
  try {
    const r = await visitPages(
      { ...opts, baseUrl: base.url },
      async (view, job) => {
        const a = await capturePage(view, opts, extra);
        if (
          !(await loadPage(
            view,
            head.url + job.url.slice(base.url.length),
            opts,
          ))
        )
          headNotReady.push(job.label);
        const b = await capturePage(view, opts, extra);
        const diff: PageDiff & Inspected = diffSnapshot(a, b);
        if ((opts.explain || opts.visual) && Object.keys(diff.changed).length) {
          // Head is loaded; base is loaded again, prepared the same way.
          const after = await inspectPage(view, diff.changed, opts);
          await loadPage(view, job.url, opts);
          await preparePage(view, opts, extra);
          if (opts.states) await tagStates(view);
          const before = await inspectPage(view, diff.changed, opts);
          Object.assign(diff, combine(before, after));
        }
        pages.push({
          file: snapshotFile(job, several).replace(".json.gz", ""),
          diff,
          entries: Object.keys(a).length,
        });
      },
    );
    pages.sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0));
    return {
      ...summarizePages(pages, [], [], opts.examples),
      ms: r.ms,
      library: swappedSheet(opts.dir, opts.sheetMarker)
        .split(path.sep)
        .join("/"),
      notReady: [...new Set([...r.notReady, ...headNotReady])],
    };
  } finally {
    base.stop();
    head.stop();
  }
}

function combine(before: PageInspection, after: PageInspection): Inspected {
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
  if (before.screenshots && after.screenshots) {
    out.pixels = {};
    for (const [path, png] of Object.entries(after.screenshots)) {
      const was = before.screenshots[path];
      if (was) out.pixels[path] = !Buffer.from(was).equals(png);
    }
  }
  return out;
}
