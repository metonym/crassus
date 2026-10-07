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
  type DeclarationStats,
  deadInFixtures,
  foldCandidates,
  type InventoryRule,
  inventoryFromRules,
  mergeAggregate,
  neverMatchedRules,
  type Summary,
  summarize,
  type UsageAggregate,
} from "../core/usage";
import { pageJobs } from "./serve";
import { processPageCdp } from "./usage-cdp";
import { type DomPageStats, processPageDom } from "./usage-dom";
import {
  type EngineName,
  reduceMotion,
  runPool,
  View,
  type Viewport,
  viewportsOf,
  waitReady,
} from "./view";

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
  /**
   * The `<html>` attribute each theme is set as, before first paint (with
   * `serveFixtures`). Default `theme`; `null` sets none.
   */
  themeAttribute?: string | null;
  settleMs?: number;
  /**
   * Visits every page at each (default 1280 × 900) and aggregates them: a
   * declaration that wins at any viewport has won.
   */
  viewports?: Viewport[];
  /**
   * Waits after load until this selector matches (polled, up to
   * `readyTimeoutMs`). A page that never matches is still read, and listed
   * in `notReady`.
   */
  readySelector?: string;
  /** Default 5000 ms. */
  readyTimeoutMs?: number;
}

/** `usage.json`. */
export interface UsageFile {
  summary: Summary;
  /** Every library declaration that matched, with its counts. */
  declarations: DeclarationStats[];
  /** Rules no page matched. */
  unmatched: InventoryRule[];
  /** `foldCandidates.length`. */
  fold: number;
  /** Observations per page (`name theme`, plus `WxH` with several viewports). */
  perPage: Record<string, number>;
  /** `deadInFixtures.length`. */
  dead: number;
  /** Pages `readySelector` never matched on. */
  notReady: string[];
  /**
   * Matched but never won, except declarations that only lose to rules
   * under `prefers-reduced-motion`, `prefers-contrast` or `forced-colors`
   * (alternatives for a user preference, not overrides).
   */
  deadInFixtures: DeclarationStats[];
  /** Dead in fixtures, always losing to the same single rule. */
  foldCandidates: DeclarationStats[];
}

export async function runUsage(opts: UsageOptions) {
  await mkdir(opts.outDir, { recursive: true });
  const marker = opts.sheetMarker;
  const viewports = viewportsOf(opts);
  const jobs = pageJobs(
    opts.baseUrl,
    opts.fixtures,
    opts.themes,
    viewports,
    opts.themeAttribute,
  );
  const aggs = new Map<View, UsageAggregate>();
  let libraryCss: string | undefined;
  const domStats: DomPageStats[] = [];
  const perPage: Record<string, number> = {};
  const started = performance.now();
  const ready = await runPool(
    jobs,
    opts.concurrency,
    () =>
      new View({
        engine: opts.engine,
        chromePath: opts.chromePath,
        ...viewports[0],
      }),
    async (view, { url, viewport, label }) => {
      let agg = aggs.get(view);
      if (!agg) {
        agg = createAggregate();
        aggs.set(view, agg);
      }
      await view.resize(viewport);
      if (opts.emulate === "cdp") await reduceMotion(view);
      await view.navigate(url);
      const ready = opts.readySelector
        ? await waitReady(view, opts.readySelector, opts.readyTimeoutMs)
        : true;
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
      perPage[label] = r.observed;
      const stats = (r as { stats?: DomPageStats }).stats;
      if (stats) domStats.push(stats);
      return ready;
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
    viewports.length,
  );
  const notReady = jobs.filter((_, i) => !ready[i]).map((j) => j.label);
  const unmatched = neverMatchedRules(agg, inventory);
  const dead = deadInFixtures(agg);
  const fold = foldCandidates(agg);
  await Bun.write(
    path.join(opts.outDir, "usage.json"),
    JSON.stringify(
      {
        summary,
        declarations: [...agg.declarations.values()],
        unmatched,
        fold: fold.length,
        perPage,
        dead: dead.length,
        notReady,
        deadInFixtures: dead,
        foldCandidates: fold,
      } satisfies UsageFile,
      null,
      2,
    ),
  );
  return { ms, summary, domStats, notReady };
}
