// What a stylesheet change can reach: the rules that changed between two
// builds, their selectors relaxed to match every element they could style in
// any state, and the computed properties those rules can move. `compare`
// reads only that, and skips pages none of the selectors match.

import { parseRules, type Rule } from "./cascade";
import { longestIncreasing } from "./diff";
import { type Node, parseStylesheet } from "./parse";
import { layerRanks } from "./placement";
import {
  argList,
  type Complex,
  type Part,
  parseComplex,
  serialize,
} from "./selector";

/** Changed rules with one relaxed selector. */
export interface ChangedSelector {
  /** Relaxed (see `relaxSelector`). */
  selector: string;
  /** The rules' own selectors, as `Rule.selector` spells them. */
  sources: string[];
  /** What the rules declare, as written (shorthands, custom properties). */
  properties: string[];
}

export interface RuleChanges {
  /** Set when any element may change, and why: such a change isn't scoped. */
  everything: string | null;
  /**
   * The changed rules by relaxed selector: an element none of them matches
   * is styled by the same rules on both sides, in every state.
   */
  selectors: ChangedSelector[];
  /** Either stylesheet has `@container` rules, which hang on layout. */
  containers: boolean;
}

// Pseudo-classes a static DOM decides alone: no user state, form value,
// text content or document state. Anything else is dropped, which only
// widens what the selector matches.
const STRUCTURAL = new Set([
  "root",
  "first-child",
  "last-child",
  "only-child",
  "first-of-type",
  "last-of-type",
  "only-of-type",
  "nth-child",
  "nth-last-child",
  "nth-of-type",
  "nth-last-of-type",
  "not",
  "is",
  "where",
  "matches",
  "-webkit-any",
  "-moz-any",
  "has",
]);
// Their arguments match the element itself, so each can be relaxed in place.
const POSITIVE = new Set(["is", "where", "matches", "-webkit-any", "-moz-any"]);

const UNIVERSAL: Part = { t: "universal" };

/** Whether the selector keeps its exact meaning on a static DOM. */
function exact(sel: Complex): boolean {
  return sel.compounds.every(({ parts }) =>
    parts.every((p) => {
      if (p.t === "pseudo-element" || p.t === "raw" || p.t === "nesting")
        return false;
      if (p.t !== "pseudo-class") return true;
      if (!STRUCTURAL.has(p.name)) return false;
      // An argument too deep to parse is kept as text.
      if (POSITIVE.has(p.name) || p.name === "not" || p.name === "has")
        return p.list?.every(exact) ?? false;
      return argList(p)?.every(exact) ?? true;
    }),
  );
}

function relaxParts(parts: Part[]): Part[] {
  const out: Part[] = [];
  for (const p of parts) {
    if (p.t === "pseudo-element" || p.t === "raw" || p.t === "nesting")
      continue;
    if (p.t !== "pseudo-class") {
      out.push(p);
      continue;
    }
    if (POSITIVE.has(p.name)) {
      if (p.list) out.push({ ...p, list: p.list.map(relaxComplex) });
      continue;
    }
    // `:not()`, `:has()` and `of S` are kept only when exact: relaxing
    // inside a negation would narrow it.
    if (!STRUCTURAL.has(p.name)) continue;
    const list = argList(p);
    if (list ? list.every(exact) : p.name !== "not" && p.name !== "has")
      out.push(p);
  }
  return out.length > 0 ? out : [UNIVERSAL];
}

function relaxComplex(sel: Complex): Complex {
  return {
    compounds: sel.compounds.map((c) => ({ parts: relaxParts(c.parts) })),
    combinators: sel.combinators,
  };
}

/**
 * `selector` widened to every element it could style: state pseudo-classes
 * (`:hover`, `:checked`) and others a static DOM can't decide are dropped,
 * a pseudo-element becomes its element, and a `:not()` or `:has()` that held
 * one goes whole. The result matches a superset, so an element it doesn't
 * match can't be styled by the rule.
 */
export function relaxSelector(selector: string): string {
  return serialize(relaxComplex(parseComplex(selector)));
}

// At-rules that carry no style rules: compared whole. `@layer` statements
// are compared as layer ranks; `@keyframes` rules come out of `parseRules`.
function atRules(nodes: Node[], into: string[] = []): string[] {
  for (const node of nodes) {
    if (node.kind === "rule" || node.rules) {
      atRules(node.rules ?? [], into);
      continue;
    }
    if (node.name === "layer" || node.name === "charset") continue;
    const decls = (node.decls ?? []).map(
      (d) => `${d.property}:${d.raw}${d.important ? "!important" : ""}`,
    );
    into.push(`@${node.name} ${node.prelude.trim()}{${decls.join(";")}}`);
  }
  return into;
}

const sameMultiset = (a: string[], b: string[]) => {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
};

const sameRanks = (a: Map<string, number>, b: Map<string, number>) =>
  a.size === b.size && [...a].every(([name, rank]) => b.get(name) === rank);

const KEYFRAMES_RE = /@(?:-[a-z]+-)?keyframes ([^ /]+)/;
const ANIMATION_RE = /^(?:-[a-z]+-)?animation(?:-name)?$/;
const TOKEN_RE = /[\s,]+/;

/** Rules that run one of `names`, from their `animation` or `animation-name`. */
function animating(rules: Rule[], names: Set<string>): Rule[] {
  return rules.filter((r) => {
    for (const [p, v] of r.decls)
      if (ANIMATION_RE.test(p) && v.split(TOKEN_RE).some((t) => names.has(t)))
        return true;
    return false;
  });
}

/** No rule differs, nor anything that reaches every page: no value can change. */
export const nothingChanged = (c: ReturnType<typeof changedRules>) =>
  !c.everything && c.selectors.length === 0;

/**
 * The rules that differ between two stylesheets: removed, added (including
 * rewritten and re-placed ones) and moved against the others, which is
 * all that can change an element's cascade within them.
 */
export function changedRules(base: string, head: string): RuleChanges {
  const containers = base.includes("@container") || head.includes("@container");
  const none = (everything: string): RuleChanges => ({
    everything,
    selectors: [],
    containers,
  });
  const [baseNodes, headNodes] = [parseStylesheet(base), parseStylesheet(head)];
  if (!sameMultiset(atRules(baseNodes), atRules(headNodes)))
    return none("an at-rule other than a style rule's group changed");
  if (!sameRanks(layerRanks(baseNodes), layerRanks(headNodes)))
    return none("the cascade layer order changed");
  const rules = { base: parseRules(base), head: parseRules(head) };
  const changed = changedDeclarations(rules.base, rules.head);
  // A changed keyframe changes what the rules running it animate, so
  // they count as changed, for what the keyframes declare.
  const frames = new Set<string>();
  const animated = new Set<string>();
  for (const [r, props] of changed) {
    const name = KEYFRAMES_RE.exec(r.context)?.[1];
    if (!name) continue;
    frames.add(name);
    for (const p of props) animated.add(p);
  }
  if (frames.size > 0)
    for (const side of [rules.base, rules.head])
      for (const r of animating(side, frames))
        changed.set(r, new Set([...(changed.get(r) ?? []), ...animated]));
  const by = new Map<
    string,
    { sources: Set<string>; properties: Set<string> }
  >();
  for (const [rule, props] of changed) {
    if (KEYFRAMES_RE.test(rule.context)) continue;
    const selector = relaxSelector(rule.selector);
    let entry = by.get(selector);
    if (!entry) {
      entry = { sources: new Set(), properties: new Set() };
      by.set(selector, entry);
    }
    entry.sources.add(rule.selector);
    for (const p of props) entry.properties.add(p);
  }
  return {
    everything: null,
    selectors: [...by]
      .map(([selector, e]) => ({
        selector,
        sources: [...e.sources].sort(),
        properties: [...e.properties].sort(),
      }))
      .sort((a, b) =>
        a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0,
      ),
    containers,
  };
}

/** Where a rule sits and what it selects: its key without the declarations. */
const slot = (r: Rule) => r.key.slice(0, r.key.length - r.declBlock.length);

const allProperties = (a: Map<string, string>, b: Map<string, string>) => [
  ...new Set([...a.keys(), ...b.keys()]),
];

/** Properties whose declaration differs between two blocks: all of them when their order changed. */
function declarationChanges(
  a: Map<string, string>,
  b: Map<string, string>,
): string[] {
  const out = new Set<string>();
  for (const [p, v] of a) if (b.get(p) !== v) out.add(p);
  for (const p of b.keys()) if (!a.has(p)) out.add(p);
  const order = (m: Map<string, string>, other: Map<string, string>) =>
    [...m.keys()].filter((p) => other.has(p)).join();
  return order(a, b) === order(b, a) ? [...out] : allProperties(a, b);
}

/**
 * Rules whose declarations can apply differently, with the properties
 * concerned. Base and head rules pair up by key, then by placement and
 * selector (an edited rule); a pair that moved against the others counts
 * whole, an edited one in place for its differing declarations, and a
 * rule on one side only for all of them.
 */
function changedDeclarations(
  base: Rule[],
  head: Rule[],
): Map<Rule, Set<string>> {
  const pairs: [Rule, Rule][] = [];
  const pair = (key: (r: Rule) => string, b: Rule[], h: Rule[]) => {
    const waiting = new Map<string, Rule[]>();
    for (const r of h) {
      const list = waiting.get(key(r));
      if (list) list.push(r);
      else waiting.set(key(r), [r]);
    }
    const restBase: Rule[] = [];
    for (const r of b) {
      const match = waiting.get(key(r))?.shift();
      if (match) pairs.push([r, match]);
      else restBase.push(r);
    }
    return { b: restBase, h: [...waiting.values()].flat() };
  };
  const exact = pair((r) => r.key, base, head);
  const edited = pair(slot, exact.b, exact.h);
  const out = new Map<Rule, Set<string>>();
  for (const r of [...edited.b, ...edited.h])
    out.set(r, new Set(r.decls.keys()));
  // Pairs in base order: those off the longest run in head order moved.
  const position = new Map(head.map((r, i) => [r, i]));
  const baseOrder = new Map(base.map((r, i) => [r, i]));
  pairs.sort((x, y) => (baseOrder.get(x[0]) ?? 0) - (baseOrder.get(y[0]) ?? 0));
  const stable = longestIncreasing(pairs.map(([, h]) => position.get(h) ?? 0));
  pairs.forEach(([b, h], i) => {
    const props = stable.has(i)
      ? declarationChanges(b.decls, h.decls)
      : [...new Set([...b.decls.keys(), ...h.decls.keys()])];
    if (props.length > 0) out.set(h, new Set(props));
  });
  return out;
}

const SIDES = ["top", "right", "bottom", "left"];

// Recorded on every element read, for `foldChanges`: its logical mapping,
// what hides a change, and what currentColor follows.
const CONTEXT = [
  "display",
  "visibility",
  "direction",
  "writing-mode",
  "color",
  "outline-style",
  "text-decoration-line",
  "opacity",
  "position",
  "clip",
  "clip-path",
  "overflow-x",
  "overflow-y",
  "width",
  "height",
  "background-color",
  "background-image",
  ...["top", "right", "bottom", "left"].flatMap((s) => [
    `border-${s}-width`,
    `border-${s}-style`,
    `padding-${s}`,
  ]),
];

// Values the CSSOM resolves against layout (`getComputedStyle` returns the
// used value): any box that moves can move them, anywhere on the page.
const LAYOUT_RE =
  /^(?:width|height|(?:min-|max-)?(?:inline|block)-size|(?:margin|padding|inset)(?:-(?:top|right|bottom|left|block-start|block-end|inline-start|inline-end))?|top|right|bottom|left|transform|transform-origin|perspective-origin|grid-template-(?:columns|rows)|x|y|cx|cy|r|rx|ry|d)$/;

// Changes that can't move a box: painted only.
const PAINT_RE =
  /(?:^|-)color$|^(?:background-(?:image|position(?:-[xy])?|size|repeat|clip|origin|attachment|blend-mode)|box-shadow|text-shadow|opacity|visibility|cursor|pointer-events|user-select|-webkit-user-select|outline-(?:style|width|offset)|text-decoration-(?:line|style|thickness|skip-ink)|text-underline-offset|fill|fill-opacity|fill-rule|stroke|stroke-(?:width|opacity|dasharray|dashoffset|linecap|linejoin|miterlimit)|transition-(?:property|duration|timing-function|delay|behavior)|z-index|mix-blend-mode|isolation|clip-path|mask-(?:image|mode|repeat|position|clip|origin|size|composite)|-webkit-mask-(?:image|repeat|position|clip|origin|size|composite)|-webkit-tap-highlight-color|-webkit-font-smoothing|image-rendering|caret-shape|scrollbar-color|touch-action|resize|scroll-behavior)$/;

// One value read through another: what a change to the key can also move.
// Font properties set `em`, `ex`, `ch` and `lh`; color is currentColor;
// writing mode and direction map every logical property.
const EVERY =
  /^(?:--|all$|font|line-height$|zoom$|writing-mode$|direction$|text-orientation$|-webkit-text-size-adjust$|text-size-adjust$)/;
const COLOR_USERS_RE =
  /color$|^(?:fill|stroke|box-shadow|text-shadow|background-image|border-image-source|filter|backdrop-filter|mask-image|-webkit-mask-image|-webkit-box-reflect)$/;
const LOGICAL_SIDES = [
  "block-start",
  "block-end",
  "inline-start",
  "inline-end",
];
const ALL_SIDES = [...SIDES, ...LOGICAL_SIDES];
const SIDE_RE = new RegExp(`-(${ALL_SIDES.join("|")})(?=-|$)`);
const CORNERS = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
  "start-start",
  "start-end",
  "end-start",
  "end-end",
];
const CORNER_RE = new RegExp(`^border-(${CORNERS.join("|")})-radius$`);
const INSETS = new Set([...SIDES, ...LOGICAL_SIDES.map((s) => `inset-${s}`)]);
const SIZES: Record<string, string> = {
  width: "inline-size",
  height: "block-size",
  "min-width": "min-inline-size",
  "min-height": "min-block-size",
  "max-width": "max-inline-size",
  "max-height": "max-block-size",
};
const SIZE_TWINS = new Map(
  Object.entries(SIZES).flatMap(([a, b]) => [
    [a, b],
    [b, a],
  ]),
);

/** The same value under another name: logical and physical twins. */
function twins(property: string): string[] {
  if (INSETS.has(property)) return [...INSETS];
  const size = SIZE_TWINS.get(property);
  if (size) return [property, size];
  if (CORNER_RE.test(property)) return CORNERS.map((c) => `border-${c}-radius`);
  const m = SIDE_RE.exec(property);
  if (!m) return [property];
  return ALL_SIDES.map((s) => property.replace(m[0], `-${s}`));
}

/**
 * The computed properties a change to `changed` (longhands, as the engine
 * expands them) can move on the elements its rules match and their
 * descendants, among `universe`, plus those `foldChanges` reads; `null` when
 * any can. `layout` when a box can move: then values resolved against
 * layout can change on any element of the page.
 */
export function impactProperties(
  changed: string[],
  universe: string[],
): { properties: string[] | null; layout: boolean } {
  const layout = changed.some((p) => !PAINT_RE.test(p));
  if (changed.some((p) => EVERY.test(p))) return { properties: null, layout };
  const out = new Set(CONTEXT);
  for (const p of changed) for (const t of twins(p)) out.add(t);
  if (changed.includes("color"))
    for (const p of universe) if (COLOR_USERS_RE.test(p)) out.add(p);
  // A style sets its width (`none` is 0), and position and float blockify.
  for (const p of [...out]) {
    if (p.endsWith("-style")) out.add(`${p.slice(0, -"style".length)}width`);
    if (p === "position" || p === "float") out.add("display");
  }
  if (out.has("position")) out.add("float");
  if (layout) for (const p of universe) if (LAYOUT_RE.test(p)) out.add(p);
  return { properties: [...out].sort(), layout };
}
