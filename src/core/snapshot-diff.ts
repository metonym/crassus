// Paths on one side only are DOM or forced-state changes: counted, not diffed.

/** Element path (with `::before`, `@hover` and similar suffixes) → longhand → computed value. */
export type Snapshot = Record<string, Record<string, string>>;

export interface PropertyChange {
  property: string;
  /** `null` when that side didn't record the property: its stylesheets don't declare it. */
  before: string | null;
  after: string | null;
}

export interface PageDiff {
  changed: Record<string, PropertyChange[]>;
  /** Paths only in base. */
  removed: string[];
  /** Paths only in head. */
  added: string[];
}

export function diffSnapshot(base: Snapshot, head: Snapshot): PageDiff {
  const out: PageDiff = { changed: {}, removed: [], added: [] };
  for (const [path, before] of Object.entries(base)) {
    const after = head[path];
    if (!after) {
      out.removed.push(path);
      continue;
    }
    const changes: PropertyChange[] = [];
    for (const [property, value] of Object.entries(before)) {
      const next = after[property] ?? null;
      if (next !== value)
        changes.push({ property, before: value, after: next });
    }
    for (const [property, value] of Object.entries(after)) {
      if (!(property in before))
        changes.push({ property, before: null, after: value });
    }
    if (changes.length) out.changed[path] = changes;
  }
  for (const path of Object.keys(head)) if (!base[path]) out.added.push(path);
  return out;
}

export interface ChangeGroup {
  property: string;
  before: string | null;
  after: string | null;
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
 */
export function groupChanges(
  pages: Iterable<{ page: string; changed: PageDiff["changed"] }>,
  examples = 3,
): ChangeGroup[] {
  const groups = new Map<string, ChangeGroup>();
  for (const { page, changed } of pages) {
    for (const [path, changes] of Object.entries(changed)) {
      for (const { property, before, after } of changes) {
        const key = JSON.stringify([property, before, after]);
        let g = groups.get(key);
        if (!g) {
          g = { property, before, after, count: 0, pages: [], examples: [] };
          groups.set(key, g);
        }
        g.count++;
        if (g.pages.at(-1) !== page) g.pages.push(page);
        if (g.examples.length < examples) g.examples.push({ page, path });
      }
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}
