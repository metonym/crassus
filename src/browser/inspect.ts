// What `compare --explain` and `--visual` read off one side of a page: the
// declaration that won each changed property, and an element screenshot.
import { SHORTHANDS } from "../core/shorthands";
import type { PropertyChange, Winner } from "../core/snapshot-diff";
import {
  authoredDeclarations,
  type CdpProperty,
  cascadeWinners,
  type MatchedRule,
} from "../core/usage";
import { STATE_SETS } from "../page/states";
import type { View } from "./view";

interface CdpRange {
  startLine: number;
  startColumn: number;
}
interface CdpRule {
  origin: string;
  styleSheetId?: string;
  selectorList: {
    text: string;
    selectors: { text: string; range?: CdpRange }[];
  };
  style: { cssProperties: CdpProperty[]; range?: CdpRange };
}
interface CdpMatch {
  matchingSelectors: number[];
  rule: CdpRule;
}
interface CdpStyles {
  inlineStyle?: { cssProperties: CdpProperty[] };
  matchedCSSRules?: CdpMatch[];
  pseudoElements?: { pseudoType: string; matches: CdpMatch[] }[];
  inherited?: {
    inlineStyle?: { cssProperties: CdpProperty[] };
    matchedCSSRules?: CdpMatch[];
  }[];
}

// Inherited by default, so an undeclared one comes from an ancestor.
const INHERITED_RE =
  /^(color|font|line-height|letter-spacing|word-spacing|text-(align|indent|transform|shadow|rendering|wrap|emphasis|underline-position)|white-space|visibility|cursor|direction|caret-color|list-style|quotes|fill|stroke|-webkit-text-(fill|stroke)|writing-mode|hyphens|tab-size|word-break|overflow-wrap|orphans|widows|pointer-events|accent-color|color-scheme)/;

const usable = (p: CdpProperty) => !p.disabled && p.parsedOk !== false;

/** The longhands whose winner explains a change: a shorthand's, and logical twins. */
function longhandsOf(change: PropertyChange): string[] {
  // Followers folded into `color` have winners of their own.
  if (change.property === "color") return ["color"];
  return [
    change.property,
    ...(SHORTHANDS[change.property] ?? []),
    ...(change.aliases ?? []),
  ];
}

type Located = MatchedRule & { winner: Omit<Winner, "inherited"> };

function rulesOf(
  styles: {
    inlineStyle?: { cssProperties: CdpProperty[] };
    matchedCSSRules?: CdpMatch[];
  },
  sheets: Map<string, string>,
): Located[] {
  const out: Located[] = [];
  for (const { matchingSelectors, rule } of styles.matchedCSSRules ?? []) {
    const declarations =
      rule.origin === "regular"
        ? authoredDeclarations(rule.style.cssProperties)
        : rule.style.cssProperties.filter(usable).map((p) => ({
            property: p.name,
            value: p.value,
            important: Boolean(p.important),
            longhands: [...(SHORTHANDS[p.name] ?? [p.name])],
          }));
    const selector = rule.selectorList.selectors[matchingSelectors[0] ?? 0];
    const range = selector?.range ?? rule.style.range;
    out.push({
      context: "",
      selector: selector?.text ?? rule.selectorList.text,
      declarations,
      winner: {
        selector: selector?.text ?? rule.selectorList.text,
        sheet:
          rule.origin === "user-agent"
            ? "user agent"
            : (sheets.get(rule.styleSheetId ?? "") ?? "inline <style>"),
        ...(range &&
          rule.origin !== "user-agent" && {
            line: range.startLine + 1,
            column: range.startColumn,
          }),
      },
    });
  }
  // Normal inline declarations beat every author rule's.
  if (styles.inlineStyle?.cssProperties.length)
    out.push({
      context: "",
      selector: "style attribute",
      declarations: authoredDeclarations(styles.inlineStyle.cssProperties),
      winner: { selector: "style attribute", sheet: "style attribute" },
    });
  return out;
}

/** The latest winning declaration among `names` (twins share one slot). */
function winnerIn(
  rules: Located[],
  names: string[],
): { winner: Omit<Winner, "inherited">; value: string } | undefined {
  const winners = cascadeWinners(rules);
  let best: { key: number[]; rule: Located; value: string } | undefined;
  const later = (a: number[], b: number[]) =>
    a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
  for (const name of names) {
    const loc = winners.get(name);
    if (!loc) continue;
    const rule = rules[loc[0]];
    const decl = rule.declarations[loc[1]];
    const key = [Number(decl.important), loc[0], loc[1]];
    if (!best || later(key, best.key)) best = { key, rule, value: decl.value };
  }
  return best && { winner: best.rule.winner, value: best.value };
}

function explain(
  styles: CdpStyles,
  pseudo: string | undefined,
  names: string[],
  sheets: Map<string, string>,
): Winner | null {
  const own = pseudo
    ? {
        matchedCSSRules: styles.pseudoElements?.find(
          (p) => p.pseudoType === pseudo,
        )?.matches,
      }
    : styles;
  const found = winnerIn(rulesOf(own, sheets), names);
  // `inherit` hands the question to the parent.
  const inherits = (w: { value: string } | undefined) =>
    w?.value.trim().toLowerCase() === "inherit";
  if (found && !inherits(found)) return found.winner;
  if (!found && !INHERITED_RE.test(names[0])) return null;
  // A pseudo-element inherits from its element first.
  const ancestors = [...(pseudo ? [styles] : []), ...(styles.inherited ?? [])];
  for (const a of ancestors) {
    const w = winnerIn(rulesOf(a, sheets), names);
    if (w && !inherits(w)) return { ...w.winner, inherited: true };
  }
  return null;
}

const PSEUDO_RE = /::(before|after)$/;

export interface PageInspection {
  /** Path -> property -> winner (`null`: none declared, an initial value). */
  explain?: Record<string, Record<string, Winner | null>>;
  /** Path -> PNG of the element, its state forced; empty when it renders no box. */
  screenshots?: Record<string, Uint8Array>;
}

/**
 * Explains and screenshots the changed elements of the page in `view`,
 * prepared as `capture` reads it (`preparePage`, then `tagStates` for
 * state keys). Chrome only.
 */
export async function inspectPage(
  view: View,
  changed: Record<string, PropertyChange[]>,
  what: { explain?: boolean; visual?: boolean },
): Promise<PageInspection> {
  const sheets = new Map<string, string>();
  const off = view.on<{ header: { styleSheetId: string; sourceURL: string } }>(
    "CSS.styleSheetAdded",
    ({ header }) => {
      const url = header.sourceURL
        ? new URL(header.sourceURL, "http://x")
        : undefined;
      if (url) sheets.set(header.styleSheetId, url.pathname.slice(1));
    },
  );
  const out: PageInspection = {
    ...(what.explain && { explain: {} }),
    ...(what.visual && { screenshots: {} }),
  };
  try {
    await view.cdp("DOM.enable");
    await view.cdp("CSS.enable");
    // Node ids hold until the next getDocument; marks are attributes.
    const { root } = await view.cdp<{ root: { nodeId: number } }>(
      "DOM.getDocument",
      { depth: 0 },
    );
    const query = (selector: string) =>
      view.cdp<{ nodeId: number }>("DOM.querySelector", {
        nodeId: root.nodeId,
        selector,
      });
    for (const [key, changes] of Object.entries(changed)) {
      // biome-ignore lint/performance/noAwaitInLoops: one CDP call at a time per view
      const target = await view.evaluate<{ state: string | null } | null>(
        `window.__cr.target(${JSON.stringify(key)})`,
      );
      if (!target) continue;
      const { nodeId } = await query("[data-cr-target]");
      const forced = target.state
        ? (await query("[data-cr-forced]")).nodeId
        : 0;
      if (forced)
        await view.cdp("CSS.forcePseudoState", {
          nodeId: forced,
          forcedPseudoClasses: STATE_SETS[target.state ?? ""],
        });
      try {
        if (out.explain) {
          const styles = await view.cdp<CdpStyles>(
            "CSS.getMatchedStylesForNode",
            { nodeId },
          );
          const pseudo = PSEUDO_RE.exec(key)?.[1];
          out.explain[key] = Object.fromEntries(
            changes.map((c) => [
              c.property,
              explain(styles, pseudo, longhandsOf(c), sheets),
            ]),
          );
        }
        if (out.screenshots) {
          const clip = await view.evaluate<null | {
            x: number;
            y: number;
            width: number;
            height: number;
          }>("window.__cr.rect()");
          const { data } = !clip
            ? { data: "" }
            : await view.cdp<{ data: string }>("Page.captureScreenshot", {
                format: "png",
                clip: { ...clip, scale: 1 },
                captureBeyondViewport: true,
              });
          out.screenshots[key] = Buffer.from(data, "base64");
        }
      } finally {
        if (forced)
          await view.cdp("CSS.forcePseudoState", {
            nodeId: forced,
            forcedPseudoClasses: [],
          });
      }
    }
  } finally {
    off();
    await view.cdp("CSS.disable");
    await view.cdp("DOM.disable");
  }
  return out;
}
