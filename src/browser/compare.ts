import { diffSnapshot, type PageDiff } from "../core/snapshot-diff";
import { serveFixtures } from "./serve";
import { type CaptureOptions, capturePage, snapshotFile } from "./snapshot";
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
export async function compareCss(
  opts: CompareOptions,
): Promise<SnapshotDiff & { ms: number; notReady: string[] }> {
  const extra = await declaredIn(opts, [opts.base, opts.head]);
  const swap = (css: string) =>
    serveFixtures(opts.dir, { swap: { marker: opts.sheetMarker, css } });
  const base = swap(opts.base);
  const head = swap(opts.head);
  const several = viewportsOf(opts).length > 1;
  const pages: { file: string; diff: PageDiff; entries: number }[] = [];
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
        pages.push({
          file: snapshotFile(job, several).replace(".json.gz", ""),
          diff: diffSnapshot(a, b),
          entries: Object.keys(a).length,
        });
      },
    );
    pages.sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0));
    return {
      ...summarizePages(pages, [], [], opts.examples),
      ms: r.ms,
      notReady: [...new Set([...r.notReady, ...headNotReady])],
    };
  } finally {
    base.stop();
    head.stop();
  }
}
