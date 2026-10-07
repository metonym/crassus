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
import { processPageCdp } from "./usage-cdp";
import { type DomPageStats, processPageDom } from "./usage-dom";
import {
  type EngineName,
  type Viewport,
  viewportsOf,
  visitPages,
} from "./view";

export interface UsageOptions {
  baseUrl: string;
  fixtures: string[];
  themes: string[];
  outDir: string;
  engine: EngineName;
  /** `cdp` asks Chrome per element (exact); `dom` matches in the page (any engine). */
  matcher: "cdp" | "dom";
  emulate: "cdp" | "cssom";
  states: boolean;
  concurrency: number;
  chromePath?: string;
  /** Text only the library stylesheet contains, e.g. a class prefix (`.bx--`). */
  sheetMarker: string;
  /** `<html>` attribute set to the theme (with `serveFixtures`). Default `theme`; `null`: none. */
  themeAttribute?: string | null;
  settleMs?: number;
  /** Default 1280 × 900. A declaration that wins at any viewport has won. */
  viewports?: Viewport[];
  /**
   * Polled after load (up to `readyTimeoutMs`). A page it never matches on is
   * still read, and listed in `notReady`.
   */
  readySelector?: string;
  /** Default 5000 ms. */
  readyTimeoutMs?: number;
}

/** `usage.json`. */
export interface UsageFile {
  summary: Summary;
  /** Every library declaration that matched. */
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
   * Matched but never won, ignoring losses to `prefers-reduced-motion`,
   * `prefers-contrast` and `forced-colors` rules (preferences, not overrides).
   */
  deadInFixtures: DeclarationStats[];
  /** Dead in fixtures, always losing to the same single rule. */
  foldCandidates: DeclarationStats[];
}

/** Which library declarations match and win on the fixture pages. */
export async function runUsage(opts: UsageOptions) {
  await mkdir(opts.outDir, { recursive: true });
  // Per view, merged in pool order so output order doesn't depend on timing.
  const aggs: UsageAggregate[] = [];
  let libraryCss: string | undefined;
  const domStats: DomPageStats[] = [];
  const perPage: Record<string, number> = {};
  const { ms, notReady } = await visitPages(
    opts,
    async (view, { label }, slot) => {
      aggs[slot] ??= createAggregate();
      const agg = aggs[slot];
      const r =
        opts.matcher === "cdp"
          ? await processPageCdp(view, agg, opts.sheetMarker, opts.states)
          : await processPageDom(
              view,
              agg,
              opts.sheetMarker,
              opts.states,
              opts.emulate === "cssom",
            );
      libraryCss ??= r.libraryCss;
      perPage[label] = r.observed;
      if (r.stats) domStats.push(r.stats);
    },
  );

  const agg = createAggregate();
  for (const a of aggs) if (a) mergeAggregate(agg, a);
  if (!libraryCss)
    throw new Error(`never found the library stylesheet (${opts.sheetMarker})`);
  const inventory = inventoryFromRules(parseRules(libraryCss));
  const summary = summarize(
    agg,
    inventory,
    opts.fixtures.length,
    opts.themes.length,
    viewportsOf(opts).length,
  );
  const dead = deadInFixtures(agg);
  const fold = foldCandidates(agg);
  await Bun.write(
    path.join(opts.outDir, "usage.json"),
    JSON.stringify(
      {
        summary,
        declarations: [...agg.declarations.values()],
        unmatched: neverMatchedRules(agg, inventory),
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
