/**
 * Rung 2: which library declarations match and win on fixture pages, over a
 * pool of tabs. `cdp` asks Chrome per element (exact); `dom` matches in the
 * page (any engine, one round trip per page).
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parseRules } from "../core/cascade";
import {
  createAggregate,
  deadInFixtures,
  foldCandidates,
  inventoryFromRules,
  mergeAggregate,
  neverMatchedRules,
  summarize,
  type UsageAggregate,
} from "../core/usage";
import { themedPages } from "./serve";
import { processPageCdp } from "./usage-cdp";
import { type DomPageStats, processPageDom } from "./usage-dom";
import { type EngineName, reduceMotion, runPool, View } from "./view";

export interface UsageOptions {
  baseUrl: string;
  fixtures: string[];
  themes: string[];
  outDir: string;
  engine: EngineName;
  matcher: "cdp" | "dom";
  emulate: "cdp" | "cssom";
  states: boolean;
  concurrency: number;
  chromePath?: string;
  /** Text only the library stylesheet contains (a class prefix, `.bx--`): how it's told apart from the page's other sheets. */
  sheetMarker: string;
  settleMs?: number;
}

export async function runUsage(opts: UsageOptions) {
  await mkdir(opts.outDir, { recursive: true });
  const marker = opts.sheetMarker;
  const jobs = themedPages(opts.baseUrl, opts.fixtures, opts.themes);
  const aggs = new Map<View, UsageAggregate>();
  let libraryCss: string | undefined;
  const domStats: DomPageStats[] = [];
  const perPage: Record<string, number> = {};
  const started = performance.now();
  await runPool(
    jobs,
    opts.concurrency,
    () => new View({ engine: opts.engine, chromePath: opts.chromePath }),
    async (view, { name, theme, url }) => {
      let agg = aggs.get(view);
      if (!agg) {
        agg = createAggregate();
        aggs.set(view, agg);
      }
      if (opts.emulate === "cdp") await reduceMotion(view);
      await view.navigate(url);
      const r =
        opts.matcher === "cdp"
          ? await processPageCdp(view, agg, marker, opts.states)
          : await processPageDom(
              view,
              agg,
              marker,
              opts.states,
              opts.emulate === "cssom",
            );
      libraryCss ??= r.libraryCss;
      perPage[`${name} ${theme}`] = r.observed;
      const stats = (r as { stats?: DomPageStats }).stats;
      if (stats) domStats.push(stats);
    },
  );
  const ms = performance.now() - started;

  const agg = createAggregate();
  for (const a of aggs.values()) mergeAggregate(agg, a);
  if (!libraryCss)
    throw new Error(`never found the library stylesheet (${marker})`);
  const inventory = inventoryFromRules(parseRules(libraryCss));
  const summary = summarize(
    agg,
    inventory,
    opts.fixtures.length,
    opts.themes.length,
  );
  const unmatched = neverMatchedRules(agg, inventory);
  await Bun.write(
    path.join(opts.outDir, "usage.json"),
    JSON.stringify(
      {
        summary,
        declarations: [...agg.declarations.values()],
        unmatched,
        fold: foldCandidates(agg).length,
        perPage,
        dead: deadInFixtures(agg).length,
      },
      null,
      2,
    ),
  );
  return { ms, summary, domStats };
}
