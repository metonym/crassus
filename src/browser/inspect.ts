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
        ...(rule.selectorList.selectors.length > 1 && {
          list: rule.selectorList.text,
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

/** A box in document coordinates, in CSS pixels. */
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One screenshot: the changed elements of one forced state (or none). */
export interface Shot {
  /** PNG of `clip`, at scale 1. */
  png: Uint8Array;
  clip: Rect;
  /** Each element's padded box; null when it renders no box. */
  boxes: Record<string, Rect | null>;
}

export interface PageInspection {
  /** Path -> property -> winner (`null`: none declared, an initial value). */
  explain?: Record<string, Record<string, Winner | null>>;
  /** Screenshots that hold every changed element, its state forced. */
  shots?: Shot[];
  /** How the screenshots were taken: pass it to the other side's inspection. */
  batches?: Batch[];
}

/** Elements screenshot together: those forced into one state at once, or none. */
interface Batch {
  state: string | null;
  /** `data-ccs-idx` of the elements forced. */
  forced: number[];
  keys: string[];
}

/** Whole pixels around a box. */
const pixelBox = (r: Rect): Rect => {
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  return {
    x,
    y,
    width: Math.ceil(r.x + r.width) - x,
    height: Math.ceil(r.y + r.height) - y,
  };
};

const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

/**
 * One screenshot per state where it can be: elements forced into the same
 * state go together when their boxes (unforced) don't overlap and neither
 * contains the other, so no forced element shows in another's crop.
 */
async function planBatches(view: View, keys: string[]): Promise<Batch[]> {
  const found = await view.evaluate<
    { state: string | null; forced: number | null; rect: Rect | null }[]
  >(`${JSON.stringify(keys)}.map((k) => {
    const t = window.__cr.target(k);
    return t && { ...t, rect: window.__cr.rect() };
  })`);
  const plain: Batch = { state: null, forced: [], keys: [] };
  // Per state, per forced element: its keys and the box around them.
  const by = new Map<
    string,
    Map<number, { keys: string[]; box: Rect | null }>
  >();
  keys.forEach((key, i) => {
    const t = found[i];
    if (!t) return;
    if (t.state === null || t.forced === null) {
      plain.keys.push(key);
      return;
    }
    const states = by.get(t.state) ?? new Map();
    by.set(t.state, states);
    const el = states.get(t.forced) ?? { keys: [], box: null };
    states.set(t.forced, el);
    el.keys.push(key);
    if (t.rect) el.box = el.box ? union([el.box, t.rect]) : t.rect;
  });
  const forced = [...new Set([...by.values()].flatMap((m) => [...m.keys()]))];
  // i -> the forced elements it contains.
  const contains = await view.evaluate<number[][]>(`((ids) => {
    const els = ids.map((i) => document.querySelector('[data-ccs-idx="' + i + '"]'));
    return els.map((a) => ids.filter((_, j) => a && els[j] && a !== els[j] && a.contains(els[j])));
  })(${JSON.stringify(forced)})`);
  const inside = new Map(forced.map((id, i) => [id, new Set(contains[i])]));
  const related = (a: number, b: number) =>
    Boolean(inside.get(a)?.has(b) || inside.get(b)?.has(a));
  const out: Batch[] = plain.keys.length ? [plain] : [];
  for (const [state, els] of by) {
    const batches: (Batch & { boxes: Rect[] })[] = [];
    for (const [id, el] of els) {
      const fits = (b: Batch & { boxes: Rect[] }) =>
        el.box !== null &&
        b.boxes.every((x) => !overlap(x, el.box as Rect)) &&
        b.forced.every((f) => !related(f, id));
      let batch = batches.find(fits);
      if (!batch || el.box === null) {
        batch = { state, forced: [], keys: [], boxes: [] };
        batches.push(batch);
      }
      batch.forced.push(id);
      batch.keys.push(...el.keys);
      if (el.box) batch.boxes.push(el.box);
    }
    out.push(...batches.map(({ boxes: _, ...b }) => b));
  }
  return out;
}

/**
 * Explains and screenshots the changed elements of the page in `view`,
 * prepared as `capture` reads it (`preparePage`, then `tagStates` for
 * state keys). Screenshots go by batch (see `planBatches`), cropped later;
 * give the other side's `batches` to take the same ones. Chrome only.
 */
export async function inspectPage(
  view: View,
  changed: Record<string, PropertyChange[]>,
  what: { explain?: boolean; visual?: boolean },
  batches?: Batch[],
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
    ...(what.visual && { shots: [] }),
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
    const force = async (ids: number[], state: string | null) => {
      for (const id of ids) {
        // biome-ignore lint/performance/noAwaitInLoops: one CDP call at a time per view
        const { nodeId } = await query(`[data-ccs-idx="${id}"]`);
        if (nodeId)
          await view.cdp("CSS.forcePseudoState", {
            nodeId,
            forcedPseudoClasses: state ? STATE_SETS[state] : [],
          });
      }
    };

    if (out.explain)
      for (const [key, changes] of Object.entries(changed)) {
        // Each element alone in its state: winners can hang on others' states.
        // biome-ignore lint/performance/noAwaitInLoops: one CDP call at a time per view
        const t = await view.evaluate<{
          state: string | null;
          forced: number | null;
        } | null>(`window.__cr.target(${JSON.stringify(key)})`);
        if (!t) continue;
        const forced = t.state !== null && t.forced !== null ? [t.forced] : [];
        await force(forced, t.state);
        try {
          const { nodeId } = await query("[data-cr-target]");
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
        } finally {
          await force(forced, null);
        }
      }

    if (out.shots) {
      // What's proven unseen (a clip, display: none, off the page) needs
      // no screenshot to say so.
      const seen = Object.keys(changed).filter((k) =>
        changed[k].some((c) => !c.invisible),
      );
      out.batches = batches ?? (await planBatches(view, seen));
      for (const batch of out.batches) {
        // biome-ignore lint/performance/noAwaitInLoops: one CDP call at a time per view
        await force(batch.forced, batch.state);
        try {
          const rects = await view.evaluate<(Rect | null)[]>(
            `${JSON.stringify(batch.keys)}.map((k) => window.__cr.target(k) && window.__cr.rect())`,
          );
          const boxes = Object.fromEntries(
            batch.keys.map((k, i) => [k, rects[i] && pixelBox(rects[i])]),
          );
          const drawn = Object.values(boxes).filter(
            (b): b is Rect => b !== null,
          );
          const clip = drawn.length ? union(drawn) : null;
          const { data } = clip
            ? await view.cdp<{ data: string }>("Page.captureScreenshot", {
                format: "png",
                clip: { ...clip, scale: 1 },
                captureBeyondViewport: true,
              })
            : { data: "" };
          out.shots.push({
            png: Buffer.from(data, "base64"),
            clip: clip ?? { x: 0, y: 0, width: 0, height: 0 },
            boxes,
          });
        } finally {
          await force(batch.forced, null);
        }
      }
    }
  } finally {
    off();
    await view.cdp("CSS.disable");
    await view.cdp("DOM.disable");
  }
  return out;
}

function union(boxes: Rect[]): Rect {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x, y, width: right - x, height: bottom - y };
}
