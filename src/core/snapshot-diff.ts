// Paths on one side only are DOM or forced-state changes, and properties one
// side only recorded have no value to compare: listed, not diffed.
import { foldChanges } from "./fold";

/** Element path (with `::before`, `@hover` and similar suffixes) → longhand → computed value. */
export type Snapshot = Record<string, Record<string, string>>;

export interface PropertyChange {
  property: string;
  before: string;
  after: string;
  /**
   * Properties that changed the same way, folded into this one: logical
   * twins under the physical name (`padding-block-start` under
   * `padding-top`, assuming a horizontal writing mode), every longhand of
   * a shorthand under its name (`border-color`), and properties that
   * follow `color` (currentColor) under `color`.
   */
  aliases?: string[];
  /**
   * Why no one can see the change on either side, when no one can:
   * `display: none` (on it or an ancestor), `visibility: hidden` (painted
   * properties), `no border` (a side's color at width 0 or style none),
   * `outline-style: none`, `text-decoration-line: none`.
   */
  invisible?: string;
}

/**
 * Properties one side recorded and the other didn't, because only that
 * side's stylesheets declare them. They aren't compared: the other side has
 * no value, and its computed one may well be the same.
 */
export interface Uncompared {
  onlyBase: string[];
  onlyHead: string[];
}

export interface PageDiff {
  changed: Record<string, PropertyChange[]>;
  /** Paths only in base. */
  removed: string[];
  /** Paths only in head. */
  added: string[];
  uncompared: Uncompared;
}

export function diffSnapshot(base: Snapshot, head: Snapshot): PageDiff {
  const changed: PageDiff["changed"] = {};
  const removed: string[] = [];
  const onlyBase = new Set<string>();
  const onlyHead = new Set<string>();
  for (const [path, before] of Object.entries(base)) {
    const after = head[path];
    if (!after) {
      removed.push(path);
      continue;
    }
    const changes: PropertyChange[] = [];
    for (const [property, value] of Object.entries(before)) {
      const next = after[property];
      if (next === undefined) onlyBase.add(property);
      else if (next !== value)
        changes.push({ property, before: value, after: next });
    }
    for (const property of Object.keys(after))
      if (!(property in before)) onlyHead.add(property);
    if (changes.length) changed[path] = foldChanges(changes, path, base, head);
  }
  return {
    changed,
    removed,
    added: Object.keys(head).filter((path) => !base[path]),
    uncompared: {
      onlyBase: [...onlyBase].sort(),
      onlyHead: [...onlyHead].sort(),
    },
  };
}

export interface ChangeGroup {
  property: string;
  before: string;
  after: string;
  /** Over all its occurrences. */
  aliases?: string[];
  /** The reason, for a group of changes no one can see. */
  invisible?: string;
  /** Element paths with this change, over all pages. */
  count: number;
  /** Pages it occurs on, in first-seen order. */
  pages: string[];
  /** The first few occurrences. */
  examples: { page: string; path: string }[];
}

/**
 * Groups changes by `(property, before, after)` across pages, so a systematic
 * change reads as one line: most frequent first, ties in first-seen order.
 * Invisible changes group apart from visible ones, by reason.
 */
export function groupChanges(
  pages: Iterable<{ page: string; changed: PageDiff["changed"] }>,
  examples = 3,
): ChangeGroup[] {
  const groups = new Map<string, ChangeGroup>();
  for (const { page, changed } of pages) {
    for (const [path, changes] of Object.entries(changed)) {
      for (const { property, before, after, aliases, invisible } of changes) {
        const key = JSON.stringify([property, before, after, invisible]);
        let g = groups.get(key);
        if (!g) {
          g = { property, before, after, count: 0, pages: [], examples: [] };
          if (invisible) g.invisible = invisible;
          groups.set(key, g);
        }
        if (aliases)
          g.aliases = [...new Set([...(g.aliases ?? []), ...aliases])].sort();
        g.count++;
        if (g.pages.at(-1) !== page) g.pages.push(page);
        if (g.examples.length < examples) g.examples.push({ page, path });
      }
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}
