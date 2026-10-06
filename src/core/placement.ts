/**
 * Where each style rule sits in the cascade: conditions (`@media`,
 * `@supports`, `@container`, …), layer and `@scope`. Every walk over a sheet
 * goes through here, so they all agree.
 *
 * Layers order by first declaration (`@layer a, b;`, `@layer a { … }`,
 * `@import … layer(a)`), sublayers before their parent's own rules,
 * unlayered last. A layer first declared under a condition only gets that
 * position if the condition holds, so it's marked uncertain.
 *
 * Nesting is flattened: `&` resolves against the parent, and declarations
 * after a nested rule, or in a group rule nested in a style rule, become
 * rules of their own (CSSNestedDeclarations).
 */

import { canonicalText, type Decl, type Node } from "./parse";
import {
  type Complex,
  parseComplex,
  resolveNested,
  serializeList,
  splitList,
} from "./selector";

export interface Layer {
  /** Dotted (`base.reset`); `""` when unlayered, `<anonymous>` segments for anonymous layers. */
  name: string;
  /** For normal declarations, higher wins; unlayered is highest. Set when the walk ends. */
  rank: number;
  /** false when the position depends on a condition. */
  certain: boolean;
  children: Layer[];
  named: Map<string, Layer>;
}

export interface Placed {
  /** `&` resolved; offsets into the sheet. */
  selectors: { complex: Complex; offset: number }[];
  /** The prelude, or for nested rules the resolved list. */
  text: string;
  decls: Decl[];
  /** Conditions, outermost first, joined with " / ". */
  context: string;
  layer: Layer;
  /** `@scope` chain, joined with " / ". */
  scope: string;
  /** In `@keyframes`: selectors are offsets. */
  keyframes: boolean;
}

interface Where {
  context: string;
  layer: Layer;
  scope: string;
  keyframes: boolean;
  /** The enclosing style rule's resolved selectors. */
  parent: Complex[] | null;
}

const AMPERSAND: Complex = {
  compounds: [{ parts: [{ t: "nesting" }] }],
  combinators: [],
};

const ANONYMOUS = "<anonymous>";
const IMPORT_LAYER_RE = /(?:^|[\s)])layer(?:\(([^)]*)\)|(?=\s|$))/i;
const KEYFRAMES_RE = /keyframes$/;

export function contextOf(name: string, prelude: string): string {
  return `@${name} ${canonicalText(prelude)}`.trim();
}

// Group rules some browser applies (`@-moz-document` is Firefox's).
const GROUP_RULES = new Set([
  "document",
  "media",
  "supports",
  "container",
  "layer",
  "scope",
  "starting-style",
  "keyframes",
]);
const VENDOR_RE = /^-[a-z]+-/;

/** Browsers keep it: a style rule, a known group rule, or `@layer`. */
function producesRules(node: Node): boolean {
  if (node.kind === "rule") return true;
  if (node.name === "layer") return true;
  return (
    node.rules !== null && GROUP_RULES.has(node.name.replace(VENDOR_RE, ""))
  );
}

const startOf = (node: Node) =>
  node.kind === "rule" ? node.preludeStart : node.start;

const join = (outer: string, inner: string) =>
  outer ? `${outer} / ${inner}` : inner;

function layer(name: string, certain: boolean): Layer {
  return { name, rank: 0, certain, children: [], named: new Map() };
}

/** Every style rule in source order, with its placement. */
export function placeRules(nodes: Node[]): Placed[] {
  const root = layer("", true);
  const out: Placed[] = [];
  let conditional = 0;

  const child = (parent: Layer, segment: string): Layer => {
    const l = layer(
      parent.name ? `${parent.name}.${segment}` : segment,
      parent.certain && conditional === 0,
    );
    parent.children.push(l);
    return l;
  };

  // A dotted layer name inside `parent`, declared if new; null declares an
  // anonymous layer.
  const declare = (parent: Layer, name: string | null): Layer => {
    if (name === null) return child(parent, ANONYMOUS);
    let l = parent;
    for (const raw of name.split(".")) {
      const segment = raw.trim();
      let next = l.named.get(segment);
      if (!next) {
        next = child(l, segment);
        l.named.set(segment, next);
      }
      l = next;
    }
    return l;
  };

  // `@import` only counts before other rules (`@charset` and `@layer;` aside).
  let importsOpen = true;

  const place = (
    selectors: Placed["selectors"],
    decls: Decl[],
    text: string | null,
    w: Where,
  ) =>
    out.push({
      selectors,
      text: text ?? serializeList(selectors.map((s) => s.complex)),
      decls,
      context: w.context,
      layer: w.layer,
      scope: w.scope,
      keyframes: w.keyframes,
    });

  // A block's declarations and nested rules in source order. Each run of
  // declarations becomes an `&` rule; a style rule's leading run is the rule
  // itself, which the caller places.
  const block = (decls: Decl[], children: Node[], from: number, w: Where) => {
    let d = from;
    const run = (end: number) => {
      const first = d;
      while (d < decls.length && decls[d].start < end) d++;
      if (d > first && w.parent)
        place(
          [
            {
              complex: resolveNested(AMPERSAND, w.parent),
              offset: decls[first].start,
            },
          ],
          decls.slice(first, d),
          null,
          w,
        );
    };
    for (const child of children) {
      if (!producesRules(child)) continue;
      run(startOf(child));
      visit(child, w);
    }
    run(Number.POSITIVE_INFINITY);
  };

  const visit = (node: Node, w: Where) => {
    if (node.kind === "rule") {
      importsOpen = false;
      const { parent } = w;
      const selectors = splitList(node.prelude).map((part) => {
        const complex = parseComplex(part.text);
        return {
          complex:
            parent && !w.keyframes ? resolveNested(complex, parent) : complex,
          offset: node.preludeStart + part.offset,
        };
      });
      const text = parent ? null : node.prelude;
      const first = node.rules.find(producesRules);
      if (!first) {
        place(selectors, node.decls, text, w);
        return;
      }
      let lead = 0;
      while (
        lead < node.decls.length &&
        node.decls[lead].start < startOf(first)
      )
        lead++;
      place(selectors, node.decls.slice(0, lead), text, w);
      block(node.decls, node.rules, lead, {
        ...w,
        parent: selectors.map((s) => s.complex),
      });
      return;
    }
    const { name, prelude, rules } = node;
    if (name === "layer") {
      if (rules) {
        importsOpen = false;
        const inner = { ...w, layer: declare(w.layer, prelude || null) };
        block(node.decls ?? [], rules, 0, inner);
      } else {
        for (const n of prelude.split(",")) if (n.trim()) declare(w.layer, n);
      }
      return;
    }
    if (name === "import") {
      if (!importsOpen) return;
      const m = IMPORT_LAYER_RE.exec(prelude);
      if (m && m[1] === undefined) declare(w.layer, null);
      else if (m?.[1]?.trim()) declare(w.layer, m[1]);
      return;
    }
    // Unknown at-rules are dropped with their rules.
    if (rules && !producesRules(node)) return;
    if (name !== "charset") importsOpen = false;
    if (!rules) return;
    conditional++;
    const inner =
      name === "scope"
        ? { ...w, scope: join(w.scope, contextOf(name, prelude)) }
        : {
            ...w,
            context: join(w.context, contextOf(name, prelude)),
            keyframes: w.keyframes || KEYFRAMES_RE.test(name),
          };
    block(node.decls ?? [], rules, 0, inner);
    conditional--;
  };
  const top: Where = {
    context: "",
    layer: root,
    scope: "",
    keyframes: false,
    parent: null,
  };
  for (const node of nodes) visit(node, top);

  let rank = 0;
  const assign = (l: Layer) => {
    for (const c of l.children) assign(c);
    l.rank = rank++;
  };
  assign(root);
  return out;
}

/** Layer name -> `Rule.layerRank`. Anonymous layers share a name: the first wins. */
export function layerRanks(nodes: Node[]): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const { layer } of placeRules(nodes))
    if (layer.name && !ranks.has(layer.name)) ranks.set(layer.name, layer.rank);
  return ranks;
}
