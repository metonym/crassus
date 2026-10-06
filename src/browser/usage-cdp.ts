/** The `cdp` usage engine: Chrome's matched rules per element. */
import { parseStylesheet } from "../core/parse";
import { canonicalContext, layerRanks } from "../core/placement";
import {
  canonicalSelector,
  parseComplex,
  parseSelectorList,
  resolveNested,
  serialize,
} from "../core/selector";
import {
  authoredDeclarations,
  type CdpProperty,
  type MatchedRule,
  recordObservation,
  type UsageAggregate,
} from "../core/usage";
import {
  INTERACTIVE,
  MAX_STATE_DESCENDANTS,
  MAX_STATE_ELEMENTS,
  STATE_SETS,
} from "../page/states";
import { librarySheet } from "./library";
import type { View } from "./view";

interface CdpRuleMatch {
  matchingSelectors: number[];
  rule: {
    origin: string;
    styleSheetId?: string;
    selectorList: { text: string; selectors: { text: string }[] };
    /** Enclosing style rules' selectors (CSS nesting), nearest first. */
    nestingSelectors?: string[];
    style: { cssProperties: CdpProperty[] };
    media?: { text: string }[];
    supports?: { text: string }[];
    containerQueries?: { conditionText?: string; text?: string }[];
    /** Enclosing `@layer` blocks, outermost first; anonymous ones have no text. */
    layers?: { text: string }[];
  };
}
interface CdpNode {
  nodeId: number;
  nodeType: number;
  nodeName: string;
  children?: CdpNode[];
}

// Layer ranks of the last library sheet seen: usually the same on every page.
let ranksFor: { text: string; ranks: Map<string, number> } | undefined;
function libraryLayerRanks(text: string): Map<string, number> {
  if (ranksFor?.text !== text)
    ranksFor = {
      text,
      ranks: text.includes("@layer")
        ? layerRanks(parseStylesheet(text))
        : new Map(),
    };
  return ranksFor.ranks;
}

/**
 * A nested rule's selector resolved as `parseRules` does it, from CDP's own
 * (relative) selector and its ancestors'. Nested declarations have none: `&`.
 */
function nestedSelector(own: string, ancestors: string[]): string {
  let parent = parseSelectorList(ancestors[ancestors.length - 1]);
  for (let i = ancestors.length - 2; i >= 0; i--) {
    const outer = parent;
    parent = parseSelectorList(ancestors[i]).map((c) =>
      resolveNested(c, outer),
    );
  }
  return serialize(resolveNested(parseComplex(own), parent));
}

function toMatchedRule(
  rm: CdpRuleMatch,
  lib: string,
  ranks: Map<string, number>,
): MatchedRule | undefined {
  const { rule } = rm;
  if (rule.origin !== "regular" || rule.styleSheetId !== lib) return undefined;
  const declarations = authoredDeclarations(rule.style.cssProperties);
  if (declarations.length === 0) return undefined;
  const idx = rm.matchingSelectors[0] ?? 0;
  const selector = rule.nestingSelectors?.length
    ? nestedSelector(
        rule.selectorList.selectors[idx]?.text ?? "&",
        rule.nestingSelectors,
      )
    : canonicalSelector(
        rule.selectorList.selectors[idx]?.text ?? rule.selectorList.text,
      );
  const context = [
    ...(rule.media ?? []).map((m) => canonicalContext("media", m.text)),
    ...(rule.supports ?? []).map((s) => canonicalContext("supports", s.text)),
    ...(rule.containerQueries ?? []).map((c) =>
      canonicalContext("container", c.conditionText ?? c.text ?? ""),
    ),
  ].join(" / ");
  const matched: MatchedRule = { context, selector, declarations };
  if (rule.layers?.length) {
    const name = rule.layers.map((l) => l.text || "<anonymous>").join(".");
    matched.layerRank = ranks.get(name);
  }
  return matched;
}

async function processPageCdpInner(
  view: View,
  agg: UsageAggregate,
  sheetMarker: string,
  states: boolean,
): Promise<{ observed: number; libraryCss?: string }> {
  const sheets: { styleSheetId: string; origin: string }[] = [];
  const off = view.on<{ header: { styleSheetId: string; origin: string } }>(
    "CSS.styleSheetAdded",
    (e) => sheets.push(e.header),
  );
  await view.cdp("DOM.enable");
  await view.cdp("CSS.enable");
  const { root } = await view.cdp<{ root: CdpNode }>("DOM.getDocument", {
    depth: -1,
    pierce: false,
  });

  const texts = await Promise.all(
    sheets
      .filter((sheet) => sheet.origin === "regular")
      .map(async ({ styleSheetId }) => ({
        styleSheetId,
        text: (
          await view.cdp<{ text: string }>("CSS.getStyleSheetText", {
            styleSheetId,
          })
        ).text,
      })),
  );
  off();
  const library = librarySheet(texts, sheetMarker);
  if (!library) return { observed: 0 };
  const lib = library.styleSheetId;
  const ranks = libraryLayerRanks(library.text);

  const matchedFor = async (nodeId: number) => {
    const res = await view.cdp<{
      matchedCSSRules?: CdpRuleMatch[];
      pseudoElements?: { pseudoType: string; matches: CdpRuleMatch[] }[];
    }>("CSS.getMatchedStylesForNode", { nodeId });
    const self = (res.matchedCSSRules ?? [])
      .map((rm) => toMatchedRule(rm, lib, ranks))
      .filter((r): r is MatchedRule => r !== undefined);
    const pseudos: MatchedRule[][] = [];
    for (const pe of res.pseudoElements ?? []) {
      if (pe.pseudoType !== "before" && pe.pseudoType !== "after") continue;
      const list = pe.matches
        .map((rm) => toMatchedRule(rm, lib, ranks))
        .filter((r): r is MatchedRule => r !== undefined);
      if (list.length > 0) pseudos.push(list);
    }
    let observed = 0;
    if (self.length > 0) {
      recordObservation(agg, self);
      observed++;
    }
    for (const list of pseudos) {
      recordObservation(agg, list);
      observed++;
    }
    return observed;
  };

  const findBody = (node: CdpNode): CdpNode | undefined => {
    if (node.nodeName === "BODY") return node;
    for (const c of node.children ?? []) {
      const f = findBody(c);
      if (f) return f;
    }
    return undefined;
  };
  const body = findBody(root);
  if (!body) return { observed: 0, libraryCss: library.text };

  const parentOf = new Map<number, number>();
  const childrenOf = new Map<number, number[]>();
  const elements: number[] = [];
  const collect = (node: CdpNode) => {
    const kids = (node.children ?? []).filter((c) => c.nodeType === 1);
    childrenOf.set(
      node.nodeId,
      kids.map((k) => k.nodeId),
    );
    for (const kid of kids) {
      parentOf.set(kid.nodeId, node.nodeId);
      elements.push(kid.nodeId);
      collect(kid);
    }
  };
  collect(body);

  let observed = 0;
  // biome-ignore lint/performance/noAwaitInLoops: one CDP call at a time per view
  for (const nodeId of elements) observed += await matchedFor(nodeId);

  if (states) {
    const { nodeIds } = await view.cdp<{ nodeIds: number[] }>(
      "DOM.querySelectorAll",
      {
        nodeId: body.nodeId,
        selector: INTERACTIVE,
      },
    );
    for (const nodeId of nodeIds.slice(0, MAX_STATE_ELEMENTS)) {
      for (const forced of Object.values(STATE_SETS)) {
        // biome-ignore lint/performance/noAwaitInLoops: one CDP call at a time per view
        await view.cdp("CSS.forcePseudoState", {
          nodeId,
          forcedPseudoClasses: forced,
        });
        const parent = parentOf.get(nodeId);
        const targets = [
          nodeId,
          ...(parent !== undefined && parent !== body.nodeId ? [parent] : []),
          ...descendantsOf(nodeId, childrenOf, MAX_STATE_DESCENDANTS),
        ];
        // biome-ignore lint/performance/noAwaitInLoops: one CDP call at a time per view
        for (const t of targets) observed += await matchedFor(t);
        await view.cdp("CSS.forcePseudoState", {
          nodeId,
          forcedPseudoClasses: [],
        });
      }
    }
  }
  return { observed, libraryCss: library.text };
}

function descendantsOf(
  nodeId: number,
  childrenOf: Map<number, number[]>,
  cap: number,
): number[] {
  const out: number[] = [];
  const stack = [...(childrenOf.get(nodeId) ?? [])];
  while (stack.length > 0 && out.length < cap) {
    const id = stack.shift();
    if (id === undefined) break;
    out.push(id);
    stack.push(...(childrenOf.get(id) ?? []));
  }
  return out;
}

/**
 * Disables the domains however it ends: a tab left with CSS enabled gets no
 * `styleSheetAdded` replay on the next page, which then finds no library.
 */
export async function processPageCdp(
  view: View,
  agg: UsageAggregate,
  sheetMarker: string,
  states: boolean,
): Promise<{ observed: number; libraryCss?: string }> {
  try {
    return await processPageCdpInner(view, agg, sheetMarker, states);
  } finally {
    await view.cdp("CSS.disable");
    await view.cdp("DOM.disable");
  }
}
