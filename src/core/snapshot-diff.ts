// Paths on one side only are DOM or forced-state changes, and properties one
// side only recorded have no value to compare: listed, not diffed.
import { foldChanges, HIDDEN } from "./fold";

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
      // Not a style: why the box can't be seen.
      if (property === HIDDEN) continue;
      const next = after[property];
      if (next === undefined) onlyBase.add(property);
      else if (next !== value)
        changes.push({ property, before: value, after: next });
    }
    for (const property of Object.keys(after))
      if (!(property in before) && property !== HIDDEN) onlyHead.add(property);
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

/** The declaration a property's computed value comes from. */
export interface Winner {
  selector: string;
  /** The stylesheet's path, `user agent`, `style attribute` or `inline <style>`. */
  sheet: string;
  /** 1-based line in the stylesheet (or, mapped, its source). */
  line?: number;
  /** 0-based column. */
  column?: number;
  /** Set when an ancestor's declaration was inherited. */
  inherited?: true;
  /** Set when the rule differs between the sides: removed, added, edited or moved. */
  changed?: true;
  /** The rule's whole selector list, when it has more than one. */
  list?: string;
}

/** Per side, the winning declaration (`null`: none declared, an initial value). */
export interface Explained {
  base: Winner | null;
  head: Winner | null;
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
  /** The first few occurrences, with the winners when explained. */
  examples: { page: string; path: string; explain?: Explained }[];
  /**
   * With element screenshots: how many of its elements' pixels differ, and
   * of those, how many by less than a just-noticeable difference (CIEDE2000
   * below 1 everywhere).
   */
  pixels?: { differ: number; same: number; imperceptible: number };
  /** Over its elements whose pixels differ (same-size crops): the largest CIEDE2000, and the mean of their means. */
  deltaE?: DeltaE;
  /**
   * With token tracing: elements where the property stopped following a
   * design token (`detached`) or follows other ones (`retokened`), and the
   * tokens it followed on base.
   */
  tokens?: { detached: number; retokened: number; from: string[] };
}

/** What drives a property on each side: tokens whose sentinel its value carried. */
export interface TokenChange {
  base: string[];
  /** Empty: the property no longer follows any token. */
  head: string[];
  /** Its value on head. */
  value?: string;
}

/**
 * Per element and property, where what drives the value changed: it
 * followed tokens at base and none at head (detached), or other ones
 * (retokened). `values` are head's, to say what it is now.
 */
export function diffTokens(
  base: Record<string, Record<string, string[]>>,
  head: Record<string, Record<string, string[]>>,
  values?: Snapshot,
): Record<string, Record<string, TokenChange>> {
  const out: Record<string, Record<string, TokenChange>> = {};
  for (const [path, props] of Object.entries(base))
    for (const [property, was] of Object.entries(props)) {
      const now = head[path]?.[property] ?? [];
      if (now.length && now.join() === was.join()) continue;
      const value = values?.[path]?.[property];
      out[path] ??= {};
      out[path][property] = {
        base: was,
        head: now,
        ...(value !== undefined && { value }),
      };
    }
  return out;
}

/** The token change on `path` for a property or one folded into it. */
export const tokenChangeOf = (
  tokens: Record<string, Record<string, TokenChange>> | undefined,
  path: string,
  c: { property: string; aliases?: string[] },
): TokenChange | undefined => {
  const at = tokens?.[path];
  if (!at) return undefined;
  for (const p of [c.property, ...(c.aliases ?? [])]) if (at[p]) return at[p];
  return undefined;
};

/** How far apart an element's pixels look between the sides (CIEDE2000, over the pixels that differ). */
export interface DeltaE {
  max: number;
  mean: number;
}

/** Below a just-noticeable difference. */
export const IMPERCEPTIBLE = 1;

/** What a page's changes were inspected for, by path. */
export interface Inspected {
  explain?: Record<string, Record<string, Explained>>;
  /** Whether the element's screenshots differ. */
  pixels?: Record<string, boolean>;
  /** For screenshots that differ at the same size: how far apart they look. */
  deltaE?: Record<string, DeltaE>;
  /** Where each changed element is in the page. */
  where?: Record<string, Where>;
  /** With token tracing: properties whose driving tokens changed, by path. */
  tokens?: Record<string, Record<string, TokenChange>>;
}

/** A changed element, as a person finds it. */
export interface Where {
  /** A CSS selector for it (`nth-child` from `body`), with `::before`/`::after`. */
  selector: string;
  /** With a report: its markup (cut at 20,000 characters)… */
  html?: string;
  /** …and its ancestors' opening tags, `<html>` first. */
  ancestors?: string[];
}

/**
 * Groups changes by `(property, before, after)` across pages, so a systematic
 * change reads as one line: most frequent first, ties in first-seen order.
 * Invisible changes group apart from visible ones, by reason.
 */
export function groupChanges(
  pages: Iterable<{ page: string; changed: PageDiff["changed"] } & Inspected>,
  examples = 3,
): ChangeGroup[] {
  const groups = new Map<string, ChangeGroup>();
  const means = new Map<ChangeGroup, number[]>();
  for (const { page, changed, explain, pixels, deltaE, tokens } of pages) {
    for (const [path, changes] of Object.entries(changed)) {
      for (const change of changes) {
        const { property, before, after, aliases, invisible } = change;
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
        const why = explain?.[path]?.[property];
        if (g.examples.length < examples)
          g.examples.push({ page, path, ...(why && { explain: why }) });
        const token = tokenChangeOf(tokens, path, change);
        if (token) {
          g.tokens ??= { detached: 0, retokened: 0, from: [] };
          g.tokens[token.head.length ? "retokened" : "detached"]++;
          g.tokens.from = [...new Set([...g.tokens.from, ...token.base])];
        }
        const differ = pixels?.[path];
        if (differ !== undefined) {
          g.pixels ??= { differ: 0, same: 0, imperceptible: 0 };
          g.pixels[differ ? "differ" : "same"]++;
          const de = deltaE?.[path];
          if (de) {
            if (de.max < IMPERCEPTIBLE) g.pixels.imperceptible++;
            g.deltaE = { max: Math.max(g.deltaE?.max ?? 0, de.max), mean: 0 };
            const list = means.get(g) ?? [];
            list.push(de.mean);
            means.set(g, list);
          }
        }
      }
    }
  }
  for (const [g, list] of means)
    if (g.deltaE) g.deltaE.mean = list.reduce((n, m) => n + m, 0) / list.length;
  return [...groups.values()].sort((a, b) => b.count - a.count);
}
