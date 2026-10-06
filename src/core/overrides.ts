/**
 * Provably dead declarations. A declaration is dead when every selector of
 * its rule is repeated, in the same context and scope, by a rule later in
 * the cascade (importance, then layer, then order) that sets the property or
 * a shorthand covering it. Both match the same elements at equal
 * specificity, so the first never wins. Layers whose order depends on a
 * condition aren't compared.
 *
 * A property repeated in one rule is dead too, unless the pair is a
 * fallback (FALLBACK_VALUE_RE).
 */

import { canonicalValue } from "./cascade";
import { locator, parseStylesheet } from "./parse";
import { type Layer, placeRules } from "./placement";
import { serialize } from "./selector";
import { SHORTHANDS } from "./shorthands";

export interface DeadDeclaration {
  context: string;
  layer: string;
  scope: string;
  selector: string;
  property: string;
  value: string;
  /** What wins instead. */
  by: { property: string; value: string; layer: string; sameRule: boolean };
  /** With `positions`: 1-based line, 0-based column. */
  loc?: { line: number; column: number };
  /** Offsets in the CSS, up to the end of the value. */
  span: [number, number];
}

// Values some browsers drop, so the declaration before is a fallback.
const FALLBACK_VALUE_RE =
  /(^|[\s(,])-(webkit|moz|ms)-|fit-content|\d[dsl]v[hw]\b|color-mix\(|\bstretch\b|^clip$/;

// In horizontal writing modes, block-axis logical properties share a slot
// with their physical twin (`inset-block-start` is `top`). The inline axis
// depends on `dir`, so it's left alone.
const PHYSICAL_TWIN: [RegExp, string][] = [
  [/^inset-block-start$/, "top"],
  [/^inset-block-end$/, "bottom"],
  [/^(margin|padding)-block-start$/, "$1-top"],
  [/^(margin|padding)-block-end$/, "$1-bottom"],
  [/^border-block-start(-width|-style|-color)?$/, "border-top$1"],
  [/^border-block-end(-width|-style|-color)?$/, "border-bottom$1"],
  [/^(min-|max-)?block-size$/, "$1height"],
  [/^(min-|max-)?inline-size$/, "$1width"],
];

function physical(property: string): string {
  for (const [pattern, twin] of PHYSICAL_TWIN)
    if (pattern.test(property)) return property.replace(pattern, twin);
  return property;
}

// Property -> the physical longhands it sets.
const longhandCache = new Map<string, ReadonlySet<string>>();
function longhandsOf(property: string): ReadonlySet<string> {
  let set = longhandCache.get(property);
  if (!set) {
    set = new Set((SHORTHANDS[property] ?? [property]).map(physical));
    longhandCache.set(property, set);
  }
  return set;
}

// Legacy names (`page-break-after`, `grid-gap`): one longhand under another
// name, or another shorthand's longhands.
const ALIASES = new Set<string>();
{
  const byLonghands = new Map<string, string>();
  for (const [name, longhands] of Object.entries(SHORTHANDS)) {
    if (longhands.length === 1) ALIASES.add(name);
    const key = longhands.join();
    const twin = byLonghands.get(key);
    if (twin) ALIASES.add(name).add(twin);
    else byLonghands.set(key, name);
  }
}

/**
 * Whether a later `laterName` resets everything an earlier `earlierName`
 * sets. An alias and its standard name (`grid-gap` and `gap`) are a
 * fallback pair either way round, so neither covers the other.
 */
export function covers(laterName: string, earlierName: string): boolean {
  const later = physical(laterName);
  const earlier = physical(earlierName);
  if (later === earlier) return true;
  if (later.startsWith("--") || earlier.startsWith("--")) return false;
  if (ALIASES.has(earlier)) return false;
  const reset = longhandsOf(later);
  const set = longhandsOf(earlier);
  if (set.size > reset.size) return false;
  for (const p of set) if (!reset.has(p)) return false;
  return !(ALIASES.has(later) && set.size === reset.size);
}

interface Decl {
  property: string;
  value: string;
  important: boolean;
  loc?: DeadDeclaration["loc"];
  span: [number, number];
}

interface Block {
  context: string;
  layer: Layer;
  scope: string;
  selectors: string[];
  decls: Decl[];
}

function blocksOf(css: string, positions: boolean): Block[] {
  const blocks: Block[] = [];
  const loc = positions ? locator(css) : null;
  for (const {
    selectors,
    decls,
    context,
    layer,
    scope,
    keyframes,
  } of placeRules(parseStylesheet(css))) {
    if (keyframes) continue;
    blocks.push({
      context,
      layer,
      scope,
      selectors: selectors.map((s) => serialize(s.complex)),
      decls: decls.map((d) => ({
        property: d.property.startsWith("--")
          ? d.property
          : d.property.toLowerCase(),
        value: canonicalValue(d.raw, false, d.property),
        important: d.important,
        loc: loc ? loc(d.start) : undefined,
        span: [d.start, d.end],
      })),
    });
  }
  return blocks;
}

/**
 * Whether `y` (in block `j`) beats `x` (in block `i`) wherever both match.
 * Within one block the caller ensures `y` comes after `x`.
 */
function beats(
  y: Decl,
  j: Block,
  jIndex: number,
  x: Decl,
  i: Block,
  iIndex: number,
): boolean {
  if (!covers(y.property, x.property)) return false;
  if (y.important !== x.important) return y.important;
  if (j.layer !== i.layer) {
    if (!(j.layer.certain && i.layer.certain)) return false;
    return y.important
      ? j.layer.rank < i.layer.rank
      : j.layer.rank > i.layer.rank;
  }
  return jIndex >= iIndex;
}

// Property -> the physical names of everything that can cover it: itself,
// its twins, the shorthands that reset it.
const coverKeyCache = new Map<string, string[]>();
function coverKeys(property: string): string[] {
  let keys = coverKeyCache.get(property);
  if (!keys) {
    keys = [physical(property)];
    if (!property.startsWith("--")) {
      for (const short in SHORTHANDS) {
        const key = physical(short);
        if (!keys.includes(key) && covers(short, property)) keys.push(key);
      }
    }
    coverKeyCache.set(property, keys);
  }
  return keys;
}

/** A declaration: `blocks[block].decls[decl]`. */
interface Ref {
  block: number;
  decl: number;
}

/** One property's declarations in a group, in source order. */
interface Entries {
  list: Ref[];
  important: boolean;
  /** Their layer if they share one. */
  layer: Layer | null;
}

/** The blocks listing one selector, and their declarations by property (built on first use). */
interface Group {
  blocks: number[];
  index?: Map<string, Entries>;
}

/** Index of the first entry after `block`'s declaration `decl`. */
function firstAfter(list: Ref[], block: number, decl: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const e = list[mid];
    if (e.block < block || (e.block === block && e.decl <= decl)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Up to this many declarations, a block's own repeats are found by scanning.
const SCAN_LIMIT = 16;

export function deadDeclarations(
  css: string,
  positions = false,
): DeadDeclaration[] {
  const blocks = blocksOf(css, positions);
  const keyOf = (block: Block, selector: string) =>
    `${block.context}\0${block.scope}\0${selector}`;
  const groups = new Map<string, Group>();
  for (let i = 0; i < blocks.length; i++) {
    for (const selector of blocks[i].selectors) {
      const key = keyOf(blocks[i], selector);
      const group = groups.get(key);
      if (group) group.blocks.push(i);
      else groups.set(key, { blocks: [i] });
    }
  }
  const indexOf = (group: Group) => {
    if (!group.index) {
      group.index = new Map();
      for (const i of group.blocks) {
        const { decls, layer } = blocks[i];
        for (let d = 0; d < decls.length; d++) {
          const prop = physical(decls[d].property);
          let entries = group.index.get(prop);
          if (!entries) {
            entries = { list: [], important: false, layer };
            group.index.set(prop, entries);
          }
          entries.list.push({ block: i, decl: d });
          if (decls[d].important) entries.important = true;
          if (entries.layer !== layer) entries.layer = null;
        }
      }
    }
    return group.index;
  };

  // The first declaration that beats `decl` of block `i`: in block `i` past
  // `after`, or in another block.
  const firstBeating = (
    group: Group,
    decl: Decl,
    i: number,
    sameBlock: boolean,
    after: number,
  ): Ref | undefined => {
    if (!sameBlock && group.blocks.length < 2) return undefined;
    const index = indexOf(group);
    let best: Ref | undefined;
    for (const key of coverKeys(decl.property)) {
      const entries = index.get(key);
      if (!entries) continue;
      const { list } = entries;
      // An earlier declaration only wins through importance or its layer.
      const earlierMayWin =
        !sameBlock && (entries.important || entries.layer !== blocks[i].layer);
      for (
        let k = earlierMayWin
          ? 0
          : firstAfter(list, i, sameBlock ? after : Number.MAX_SAFE_INTEGER);
        k < list.length;
        k++
      ) {
        const e = list[k];
        if (sameBlock && e.block !== i) break;
        if (e.block === i && !sameBlock) continue;
        if (
          best &&
          (e.block > best.block ||
            (e.block === best.block && e.decl > best.decl))
        )
          break;
        const y = blocks[e.block].decls[e.decl];
        if (beats(y, blocks[e.block], e.block, decl, blocks[i], i)) {
          best = e;
          break;
        }
      }
    }
    return best;
  };

  const dead: DeadDeclaration[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const own: Group[] = [];
    for (const selector of block.selectors) {
      const group = groups.get(keyOf(block, selector));
      if (group) own.push(group);
    }
    for (let d = 0; d < block.decls.length; d++) {
      const decl = block.decls[d];
      const report = (by: Decl, byBlock: Block, sameRule: boolean) =>
        dead.push({
          context: block.context,
          layer: block.layer.name,
          scope: block.scope,
          selector: block.selectors.join(","),
          property: decl.property,
          value: decl.value,
          by: {
            property: by.property,
            value: by.value,
            layer: byBlock.layer.name,
            sameRule,
          },
          loc: decl.loc,
          span: decl.span,
        });

      const siblingAt =
        own.length > 0 && block.decls.length > SCAN_LIMIT
          ? (firstBeating(own[0], decl, i, true, d)?.decl ?? -1)
          : block.decls.findIndex(
              (o, k) => k > d && beats(o, block, i, decl, block, i),
            );
      if (siblingAt >= 0) {
        const sibling = block.decls[siblingAt];
        const fallback =
          sibling.property === decl.property &&
          (FALLBACK_VALUE_RE.test(sibling.value) ||
            FALLBACK_VALUE_RE.test(decl.value));
        if (!fallback) report(sibling, block, true);
        continue;
      }

      if (own.length === 0) continue;
      const winner = firstBeating(own[0], decl, i, false, -1);
      if (
        winner &&
        own.slice(1).every((g) => firstBeating(g, decl, i, false, -1))
      )
        report(
          blocks[winner.block].decls[winner.decl],
          blocks[winner.block],
          false,
        );
    }
  }
  return dead;
}
