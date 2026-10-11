// Folds one element's computed-style changes so a single cause reads as one
// change: logical twins, a shorthand's longhands and `color` followers become
// `aliases` of the change they repeat, and changes no one can see are marked.
import { parseColor } from "./color";
import { SHORTHANDS } from "./shorthands";
import type { PropertyChange, Snapshot } from "./snapshot-diff";

type Direction = "ltr" | "rtl";
type StyleRecord = Record<string, string>;

const LOGICAL_RE = /(block|inline)-(start|end)/;
const SIZE_RE = /^(min-|max-)?(inline|block)-size$/;
const CORNER_RE = /^border-(start|end)-(start|end)-radius$/;
const LOGICAL_NAME_RE = /block|inline|-start|-end/;

function side(axis: string, edge: string, dir: Direction): string {
  if (axis === "block") return edge === "start" ? "top" : "bottom";
  return (edge === "start") === (dir === "ltr") ? "left" : "right";
}

/** The physical twin of a logical property in a horizontal writing mode. */
function physical(property: string, dir: Direction): string | undefined {
  const size = SIZE_RE.exec(property);
  if (size)
    return `${size[1] ?? ""}${size[2] === "inline" ? "width" : "height"}`;
  const corner = CORNER_RE.exec(property);
  if (corner)
    return `border-${side("block", corner[1], dir)}-${side("inline", corner[2], dir)}-radius`;
  const m = LOGICAL_RE.exec(property);
  if (!m) return undefined;
  const out = property.replace(m[0], side(m[1], m[2], dir));
  return out.startsWith("inset-") ? out.slice("inset-".length) : out;
}

/** Shorthands by physical longhand set, largest first, a physical name preferred. */
const shorthandTables = new Map<Direction, [string, string[]][]>();
function shorthands(dir: Direction): [string, string[]][] {
  let table = shorthandTables.get(dir);
  if (table) return table;
  const bySet = new Map<string, [string, string[]]>();
  for (const [name, longhands] of Object.entries(SHORTHANDS)) {
    if (longhands.length < 2) continue;
    const set = longhands.map((l) => physical(l, dir) ?? l);
    const key = [...set].sort().join();
    const seen = bySet.get(key);
    if (!seen || rank(name) < rank(seen[0])) bySet.set(key, [name, set]);
  }
  table = [...bySet.values()].sort((a, b) => b[1].length - a[1].length);
  shorthandTables.set(dir, table);
  return table;
}
const rank = (name: string) =>
  (name.startsWith("-") || LOGICAL_NAME_RE.test(name) ? 1000 : 0) + name.length;

// Properties whose initial value is currentColor.
const FOLLOWERS = new Set([
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "outline-color",
  "caret-color",
  "column-rule-color",
  "text-decoration-color",
  "text-emphasis-color",
  "-webkit-text-fill-color",
  "-webkit-text-stroke-color",
]);

// Painted only: hidden with the element, while layout properties still move
// its neighbors.
const COLOR_RE = /(?:^|-)color$/;
const PAINT = new Set([
  "background-image",
  "box-shadow",
  "text-shadow",
  "opacity",
  "filter",
  "backdrop-filter",
  "cursor",
  "outline-style",
  "outline-width",
  "outline-offset",
  "text-decoration-line",
  "text-decoration-style",
  "text-decoration-thickness",
]);
const BORDER_COLOR_RE = /^border-(top|right|bottom|left)-color$/;
const HIDDEN_VISIBILITY = new Set(["hidden", "collapse"]);
const NO_BORDER = new Set(["none", "hidden"]);
const STATE_SUFFIX_RE = /(@(?:hover|focus|active)\^?)?(::before|::after)?$/;

/**
 * The records of the element at `key` and of its recorded ancestors,
 * nearest first; a pseudo-element's own element comes right after it.
 * Under a forced state, the state's records stand in for the plain ones.
 */
function lineage(snap: Snapshot, key: string): StyleRecord[] {
  const out: StyleRecord[] = [];
  if (snap[key]) out.push(snap[key]);
  const m = STATE_SUFFIX_RE.exec(key);
  const path = key.slice(0, m?.index ?? key.length);
  const state = m?.[1] ?? "";
  const plain = state.replace("^", "");
  const at = (p: string) =>
    snap[p + state] ?? (plain && snap[`${p + plain}^`]) ?? snap[p];
  if (m?.[2]) {
    const own = at(path);
    if (own) out.push(own);
  }
  for (let i = path.lastIndexOf(">"); i > 0; i = path.lastIndexOf(">", i - 1)) {
    const r = at(path.slice(0, i));
    if (r) out.push(r);
  }
  return out;
}

/** Set by `capture` on an element whose box can't be seen: why. */
export const HIDDEN = "--cr-hidden";

const OUT_OF_FLOW = new Set(["absolute", "fixed"]);
const CLIPPING = new Set(["hidden", "clip"]);
const ZERO_RECT_RE =
  /^rect\(\s*(-?[\d.]+)px[\s,]+(-?[\d.]+)px[\s,]+(-?[\d.]+)px[\s,]+(-?[\d.]+)px\s*\)$/;
const INSET_RE = /^inset\(\s*(\d+(?:\.\d+)?)%\s*\)$/;
const PX_RE = /^(-?[\d.]+)px$/;
const px = (v: string | undefined) => {
  const m = v === undefined ? null : PX_RE.exec(v);
  return m ? Number(m[1]) : Number.NaN;
};
const SIDES = ["top", "right", "bottom", "left"];

/** Why nothing of `r` (and what it contains) is painted, if so. */
function clippedAway(r: StyleRecord): string | undefined {
  if (OUT_OF_FLOW.has(r.position)) {
    // `clip` applies to absolutely positioned boxes: top, right, bottom, left.
    const m = ZERO_RECT_RE.exec(r.clip ?? "");
    if (m && (Number(m[2]) <= Number(m[4]) || Number(m[3]) <= Number(m[1])))
      return "clip: rect(0 0 0 0)";
    if (
      px(r.width) <= 1 &&
      px(r.height) <= 1 &&
      CLIPPING.has(r["overflow-x"]) &&
      CLIPPING.has(r["overflow-y"])
    )
      return "1px box, overflow: hidden";
  }
  const inset = INSET_RE.exec(r["clip-path"] ?? "");
  if (inset && Number(inset[1]) >= 50) return "clip-path: inset(50%)";
  return undefined;
}

/**
 * Why the element with `records` (its `lineage`) can't be seen, if it can't,
 * and whether that holds for every property (its box is out of flow, so even
 * its layout moves nothing anyone sees) or only for painted ones.
 */
function concealed(
  own: StyleRecord,
  records: StyleRecord[],
): { why: string; all: boolean } | undefined {
  // A declared clip first: screen-reader-only text reads the same wherever
  // it sits, though it may also be off the page.
  for (const r of records) {
    const why = clippedAway(r);
    if (why) return { why, all: OUT_OF_FLOW.has(r.position) };
  }
  if (own[HIDDEN])
    return { why: own[HIDDEN], all: OUT_OF_FLOW.has(own.position) };
  if (records.some((r) => r.opacity === "0"))
    return { why: "opacity: 0", all: false };
  return undefined;
}

/**
 * Properties that changed the same way, folded as `foldChanges` folds
 * them (assuming a horizontal, left-to-right element): logical twins under
 * their physical name, `color`'s followers under `color`, full sets of
 * longhands under their shorthand. What each folded is in `also`.
 */
export function foldNames(
  properties: string[],
): { property: string; also: string[] }[] {
  const by = new Map<string, Set<string>>();
  for (const p of properties) {
    const name = physical(p, "ltr") ?? p;
    const also = by.get(name) ?? new Set<string>();
    if (name !== p) also.add(p);
    by.set(name, also);
  }
  const color = by.get("color");
  if (color)
    for (const [name, also] of by)
      if (FOLLOWERS.has(name)) {
        color.add(name);
        for (const a of also) color.add(a);
        by.delete(name);
      }
  for (const [name, longhands] of shorthands("ltr")) {
    if (!longhands.every((l) => by.has(l))) continue;
    const also = new Set<string>();
    for (const l of longhands) {
      also.add(l);
      for (const a of by.get(l) ?? []) also.add(a);
      by.delete(l);
    }
    by.set(name, also);
  }
  return [...by].map(([property, also]) => ({
    property,
    also: [...also].sort(),
  }));
}

/** Why no one can see the element at `key` in `snap`, if no one can. */
export function unseen(snap: Snapshot, key: string): string | undefined {
  const records = lineage(snap, key);
  return records[0] && concealed(records[0], records)?.why;
}

/** A border box of 0 × 0: nothing of its own box is painted. */
const emptyBox = (r: StyleRecord) =>
  px(r.width) === 0 &&
  px(r.height) === 0 &&
  SIDES.every(
    (s) => px(r[`padding-${s}`]) === 0 && px(r[`border-${s}-width`]) === 0,
  );
const OWN_BOX_RE = /^(?:background-|border-)/;

// Text paint that follows the text: unseen when the text is.
const TEXT_FOLLOWERS = new Set([
  "caret-color",
  "text-decoration-color",
  "text-emphasis-color",
  "-webkit-text-fill-color",
  "-webkit-text-stroke-color",
]);

/** The opaque color text is drawn on, from the nearest painted background; undefined when unsure. */
function backdrop(records: StyleRecord[]): string | undefined {
  for (const r of records) {
    if (emptyBox(r)) continue;
    if (r["background-image"] && r["background-image"] !== "none") return;
    const c = parseColor(r["background-color"] ?? "");
    if (!c) return;
    if (c[3] === 0) continue;
    return c[3] === 1 ? `${c[0]},${c[1]},${c[2]}` : undefined;
  }
  return undefined;
}

function textHidden(own: StyleRecord, records: StyleRecord[]): boolean {
  const c = parseColor(own.color ?? "");
  if (c?.[3] !== 1) return false;
  const bg = backdrop(records);
  return bg !== undefined && bg === `${c[0]},${c[1]},${c[2]}`;
}

/** Why `property` can't be seen on either side, if it can't. */
function invisibleOn(
  property: string,
  before: StyleRecord,
  after: StyleRecord,
): string | undefined {
  const both = (test: (r: StyleRecord) => boolean) =>
    test(before) && test(after);
  if (
    (COLOR_RE.test(property) || PAINT.has(property)) &&
    both((r) => HIDDEN_VISIBILITY.has(r.visibility))
  )
    return "visibility: hidden";
  const border = BORDER_COLOR_RE.exec(property);
  if (
    border &&
    both(
      (r) =>
        r[`border-${border[1]}-width`] === "0px" ||
        NO_BORDER.has(r[`border-${border[1]}-style`]),
    )
  )
    return "no border";
  if (
    (property === "outline-color" || property === "outline-offset") &&
    both((r) => r["outline-style"] === "none")
  )
    return "outline-style: none";
  if (
    property === "text-decoration-color" &&
    both((r) => r["text-decoration-line"] === "none")
  )
    return "text-decoration-line: none";
  return undefined;
}

const same = (a: PropertyChange, b: PropertyChange) =>
  a.before === b.before && a.after === b.after && a.invisible === b.invisible;

function absorb(into: PropertyChange, names: string[]) {
  into.aliases = [...new Set([...(into.aliases ?? []), ...names])].sort();
}

/** One element's changes, folded. `key` is its path in both snapshots. */
export function foldChanges(
  changes: PropertyChange[],
  key: string,
  base: Snapshot,
  head: Snapshot,
): PropertyChange[] {
  const before = base[key];
  const after = head[key];

  // Logical twins, under their physical names. Only in a horizontal writing
  // mode, in one direction on both sides.
  const horizontal = (r: StyleRecord) =>
    (r["writing-mode"] ?? "horizontal-tb") === "horizontal-tb";
  const dir = (before.direction ?? "ltr") as Direction;
  const mapped =
    horizontal(before) &&
    horizontal(after) &&
    dir === (after.direction ?? "ltr");
  const byName = new Map<string, PropertyChange[]>();
  for (const c of changes) {
    const name = (mapped && physical(c.property, dir)) || c.property;
    const list = byName.get(name) ?? [];
    list.push(c);
    byName.set(name, list);
  }
  let out: PropertyChange[] = [];
  for (const [name, list] of byName) {
    if (list.length > 1 && !list.every((c) => same(c, list[0]))) {
      out.push(...list);
      continue;
    }
    const c: PropertyChange = { ...list[0], property: name };
    const others = list.map((l) => l.property).filter((p) => p !== name);
    if (others.length) absorb(c, others);
    out.push(c);
  }

  const sides = [
    [before, lineage(base, key)],
    [after, lineage(head, key)],
  ] as const;
  const hidden = sides.every(([, rs]) => rs.some((r) => r.display === "none"));
  const unseen = sides.map(([own, rs]) => concealed(own, rs));
  const empty = emptyBox(before) && emptyBox(after);
  for (const c of out) {
    const paint = COLOR_RE.test(c.property) || PAINT.has(c.property);
    const why = hidden
      ? "display: none"
      : unseen.every((u) => u && (u.all || paint))
        ? unseen[0]?.why
        : empty && OWN_BOX_RE.test(c.property)
          ? "0×0 box"
          : invisibleOn(c.property, before, after);
    if (why) c.invisible = why;
  }

  // Followers of `color`, while they still equal it on both sides.
  const color = out.find((c) => c.property === "color");
  if (color) {
    const followers = out.filter(
      (c) =>
        FOLLOWERS.has(c.property) &&
        c.before === before.color &&
        c.after === after.color,
    );
    for (const f of followers)
      absorb(color, [f.property, ...(f.aliases ?? [])]);
    out = out.filter((c) => !followers.includes(c));
    // Text drawn in the color of what's behind it, with nothing else
    // following its color.
    if (
      !color.invisible &&
      (color.aliases ?? []).every((a) => TEXT_FOLLOWERS.has(a)) &&
      sides.every(([own, rs]) => textHidden(own, rs))
    )
      color.invisible = "text color equals the background";
  }

  // Longhands that all changed the same way, under their shorthand.
  if (out.length > 1) {
    const by = new Map(out.map((c) => [c.property, c]));
    for (const [name, longhands] of shorthands(mapped ? dir : "ltr")) {
      const first = by.get(longhands[0]);
      if (!first) continue;
      const parts = longhands.map((l) => by.get(l));
      if (!parts.every((p) => p && same(p, first))) continue;
      const merged: PropertyChange = { ...first, property: name };
      merged.aliases = undefined;
      absorb(
        merged,
        parts.flatMap((p) => [p?.property ?? "", ...(p?.aliases ?? [])]),
      );
      for (const l of longhands) by.delete(l);
      by.set(name, merged);
    }
    out = [...by.values()];
  }
  return out;
}
