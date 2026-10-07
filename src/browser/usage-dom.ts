// Drives src/page/usage-dom.ts; rule alignment and cascade order are in
// src/core/align.ts.
import {
  alignRules,
  cascadeOrder,
  type EngineDeclInfo,
  engineDeclarations,
  libraryRules,
} from "../core/align";
import { recordObservation, type UsageAggregate } from "../core/usage";
import type { UsageDomApi } from "../page/usage-dom";
import { librarySheet } from "./library";
import { usageDomScript } from "./page-script" with { type: "macro" };
import type { View } from "./view";

const PAGE_SCRIPT = usageDomScript();

export interface DomPageStats {
  elements: number;
  matchCalls: number;
  prepMs: number;
  matchMs: number;
  aligned: number;
  unaligned: number;
  skippedSelectors: number;
}

export interface PageUsage {
  observed: number;
  libraryCss?: string;
  stats?: DomPageStats;
}

export async function processPageDom(
  view: View,
  agg: UsageAggregate,
  sheetMarker: string,
  states: boolean,
  emulateCssom: boolean,
): Promise<PageUsage> {
  await view.evaluate(PAGE_SCRIPT);
  if (emulateCssom) await view.evaluate("window.__crDom.reducedMotion()");
  const sheets = await view.evaluate<ReturnType<UsageDomApi["sheets"]>>(
    `window.__crDom.sheets(${JSON.stringify(sheetMarker)})`,
  );
  const library = librarySheet(
    await Promise.all(
      sheets.map(async (s) => ({
        i: s.i,
        text: s.href ? await (await fetch(s.href)).text() : s.inline,
      })),
    ),
    sheetMarker,
  );
  if (!library) return { observed: 0 };

  const inventory = await view.evaluate<ReturnType<UsageDomApi["inventory"]>>(
    `window.__crDom.inventory(${library.i})`,
  );
  const aligned = alignRules(
    inventory.map((r) => r.sel),
    libraryRules(library.text),
  );

  const { pairs, resolve } = engineDeclarations(aligned);
  const declarations = resolve(
    await view.evaluate<EngineDeclInfo>(
      `window.__crDom.declInfo(${JSON.stringify(pairs)})`,
    ),
  );

  const res = await view.evaluate<ReturnType<UsageDomApi["run"]>>(
    `window.__crDom.run(${states})`,
  );

  let observed = 0;
  for (const [, matches] of res.observations) {
    const rules = cascadeOrder(matches, aligned, declarations);
    if (rules.length === 0) continue;
    recordObservation(agg, rules);
    observed++;
  }
  const unaligned = aligned.filter((a) => !a).length;
  return {
    observed,
    libraryCss: library.text,
    stats: { ...res.stats, aligned: aligned.length - unaligned, unaligned },
  };
}
