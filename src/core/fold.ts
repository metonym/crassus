// Folds one element's computed-style changes so a single cause reads as one
// change: logical twins, a shorthand's longhands and `color` followers become
// `aliases` of the change they repeat, and changes no one can see are marked.
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

/** Whether the element at `key`, or one of its recorded ancestors, has `display: none`. */
function undisplayed(snap: Snapshot, key: string): boolean {
  if (snap[key]?.display === "none") return true;
  const m = STATE_SUFFIX_RE.exec(key);
  const path = key.slice(0, m?.index ?? key.length);
  const state = m?.[1] ?? "";
  const plain = state.replace("^", "");
  const at = (p: string) =>
    snap[p + state] ?? (plain && snap[`${p + plain}^`]) ?? snap[p];
  // A pseudo-element's own element first.
  if (m?.[2] && at(path)?.display === "none") return true;
  for (let i = path.lastIndexOf(">"); i > 0; i = path.lastIndexOf(">", i - 1))
    if (at(path.slice(0, i))?.display === "none") return true;
  return false;
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

  const hidden = undisplayed(base, key) && undisplayed(head, key);
  for (const c of out) {
    const why = hidden
      ? "display: none"
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
