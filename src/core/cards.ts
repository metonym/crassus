// Change cards: a compare's changes grouped by root cause, the rule that
// changed and so stopped or started winning, each with what a person or an
// agent needs to act on it without opening a snapshot. One model, rendered
// as JSON (`crassus/report@1`), HTML, Markdown, a terminal summary and SARIF.
import {
  type DeltaE,
  IMPERCEPTIBLE,
  type Inspected,
  type PageDiff,
  type Winner,
} from "./snapshot-diff";
import { shortHash } from "./util";

const REPORT_SCHEMA = "crassus/report@1";

export type Verdict = "visible" | "imperceptible" | "invisible";

export interface Cause {
  /**
   * `lost`: a rule that differs between the sides set these on base and
   * no longer does. `won`: one now sets them on head. `shifted`: the
   * winners differ but neither rule changed (the cascade moved around
   * them). `value`: no winners known (run with `explain`).
   */
  kind: "lost" | "won" | "shifted" | "value";
  /** The rule that changed, for `lost` and `won`. */
  rule?: Winner;
  /** The winners on each side, when they're the same for every element. */
  base?: Winner | null;
  head?: Winner | null;
}

export interface CardChange {
  property: string;
  before: string;
  after: string;
  aliases?: string[];
  /** Elements with it. */
  count: number;
}

export interface CardElement {
  page: string;
  path: string;
  /** A CSS selector for it. */
  selector?: string;
  properties: string[];
  /** Whether its pixels differ, and by how much (see `compare --visual`). */
  pixels?: boolean;
  deltaE?: DeltaE;
  html?: string;
  ancestors?: string[];
  /** Paths of its crops in the report directory, when written. */
  images?: { base: string; head: string; diff: string };
  /** With `bisect`: the end of the range it changed in. */
  commit?: string;
}

export interface Fix {
  text: string;
  file?: string;
  line?: number;
  selector?: string;
  /** Declarations that would restore base's values (computed values). */
  add?: Record<string, string>;
}

export interface Card {
  /** Stable across runs: the cause and the properties it moved. */
  id: string;
  verdict: Verdict;
  /** Why no one can see it, for an invisible card. */
  invisible?: string;
  title: string;
  cause: Cause;
  changes: CardChange[];
  /** Elements, first page first. */
  elements: CardElement[];
  pages: string[];
  pixels?: { differ: number; same: number; imperceptible: number };
  deltaE?: DeltaE;
  fix?: Fix;
  /** With `bisect`: the commits the change came in. */
  commits?: { sha: string; subject: string }[];
  /** The card in one sentence, for readers without the images. */
  alt: string;
  /** The changed rule at its source, when it could be read. */
  source?: {
    file: string;
    line: number;
    /** A few lines around it. */
    excerpt?: string;
    vscode?: string;
    github?: string;
  };
}

export interface Report {
  schema: typeof REPORT_SCHEMA;
  command: "compare" | "bisect";
  /** What was compared: a ref, a file, a range. */
  base: string;
  head: string;
  summary: Record<Verdict, number>;
  cards: Card[];
}

type Page = { file: string } & Pick<PageDiff, "changed"> & Inspected;

/** `sheet:line`, or the sheet alone. */
export const loc = (w: Winner) => `${w.sheet}${w.line ? `:${w.line}` : ""}`;
/** `selector (sheet:line, inherited)`. */
export const where = (w: Winner) =>
  `${w.selector} (${loc(w)}${w.inherited ? ", inherited" : ""})`;
const winnerKey = (w: Winner | null | undefined) =>
  w ? `${w.selector}@${w.sheet}${w.inherited ? "^" : ""}` : "none";
const list = (items: string[], max = 4) =>
  items.slice(0, max).join(", ") +
  (items.length > max ? ` and ${items.length - max} more` : "");

interface Slot {
  key: string;
  cause: Cause;
  invisible?: string;
  commits: Map<string, string>;
  changes: Map<string, CardChange>;
  elements: Map<string, CardElement>;
  bases: Set<string>;
  heads: Set<string>;
}

/**
 * Cards from compared pages (one `compare`, or the hits of a `bisect` with
 * their commits): each change goes to the rule that changed among its
 * winners (the base one first), a change no changed rule explains goes
 * to its element's, and what no one can see goes to a card of its own.
 */
export function buildCards(
  runs: {
    pages: Page[];
    commits?: { sha: string; subject: string }[];
    /** Set on its elements. */
    commit?: string;
  }[],
): Card[] {
  const slots = new Map<string, Slot>();
  for (const run of runs)
    for (const page of run.pages)
      for (const [path, changes] of Object.entries(page.changed)) {
        const explained = page.explain?.[path] ?? {};
        const own = (property: string): Cause | undefined => {
          const e = explained[property];
          if (e?.base?.changed) return { kind: "lost", rule: e.base };
          if (e?.head?.changed) return { kind: "won", rule: e.head };
          return undefined;
        };
        // The element's own changed rules take what nothing else explains.
        const first = changes.map((c) => own(c.property)).find(Boolean);
        for (const c of changes) {
          const e = explained[c.property];
          const cause: Cause = own(c.property) ??
            first ?? {
              kind: e ? "shifted" : "value",
              ...(e && { base: e.base, head: e.head }),
            };
          const key = [
            cause.kind,
            // However it reached the element, the same rule is one cause.
            cause.rule
              ? winnerKey({ ...cause.rule, inherited: undefined })
              : cause.kind === "shifted"
                ? `${winnerKey(cause.base)}>${winnerKey(cause.head)}`
                : `${c.property}:${c.before}>${c.after}`,
            c.invisible ?? "",
          ].join("|");
          let slot = slots.get(key);
          if (!slot) {
            slot = {
              key,
              cause,
              ...(c.invisible && { invisible: c.invisible }),
              commits: new Map(),
              changes: new Map(),
              elements: new Map(),
              bases: new Set(),
              heads: new Set(),
            };
            slots.set(key, slot);
          }
          for (const commit of run.commits ?? [])
            slot.commits.set(commit.sha, commit.subject);
          if (e) {
            slot.bases.add(winnerKey(e.base));
            slot.heads.add(winnerKey(e.head));
          }
          const changeKey = `${c.property}\0${c.before}\0${c.after}`;
          const change = slot.changes.get(changeKey) ?? {
            property: c.property,
            before: c.before,
            after: c.after,
            count: 0,
          };
          change.count++;
          if (c.aliases)
            change.aliases = [
              ...new Set([...(change.aliases ?? []), ...c.aliases]),
            ].sort();
          slot.changes.set(changeKey, change);
          const elKey = `${run.commit ?? ""}\0${page.file}\0${path}`;
          let el = slot.elements.get(elKey);
          if (!el) {
            const w = page.where?.[path];
            el = {
              page: page.file,
              path,
              ...(run.commit && { commit: run.commit }),
              ...(w?.selector && { selector: w.selector }),
              properties: [],
              ...(page.pixels?.[path] !== undefined && {
                pixels: page.pixels[path],
              }),
              ...(page.deltaE?.[path] && { deltaE: page.deltaE[path] }),
              ...(w?.html && { html: w.html }),
              ...(w?.ancestors && { ancestors: w.ancestors }),
            };
            slot.elements.set(elKey, el);
          }
          if (!el.properties.includes(c.property))
            el.properties.push(c.property);
        }
      }
  const order = { visible: 0, imperceptible: 1, invisible: 2 };
  return [...slots.values()]
    .map(toCard)
    .sort(
      (a, b) =>
        order[a.verdict] - order[b.verdict] ||
        b.elements.length - a.elements.length ||
        (a.id < b.id ? -1 : 1),
    );
}

function toCard(slot: Slot): Card {
  const elements = [...slot.elements.values()];
  const changes = [...slot.changes.values()].sort((a, b) => b.count - a.count);
  const properties = [...new Set(changes.map((c) => c.property))];
  const pages = [...new Set(elements.map((e) => e.page))];
  const checked = elements.filter((e) => e.pixels !== undefined);
  const perceptible = (e: CardElement) =>
    e.pixels === true && (!e.deltaE || e.deltaE.max >= IMPERCEPTIBLE);
  const pixels = checked.length
    ? {
        differ: checked.filter((e) => e.pixels).length,
        same: checked.filter((e) => !e.pixels).length,
        imperceptible: checked.filter((e) => e.pixels && !perceptible(e))
          .length,
      }
    : undefined;
  const deltas = elements.flatMap((e) => (e.deltaE ? [e.deltaE] : []));
  const deltaE = deltas.length
    ? {
        max: Math.max(...deltas.map((d) => d.max)),
        mean: deltas.reduce((n, d) => n + d.mean, 0) / deltas.length,
      }
    : undefined;
  const verdict: Verdict = slot.invisible
    ? "invisible"
    : pixels && checked.length === elements.length && !checked.some(perceptible)
      ? "imperceptible"
      : "visible";
  // Winners every element shares, worth naming.
  const cause = slot.cause;
  // Winners every element shares, worth naming.
  const other = (side: "bases" | "heads") =>
    slot[side].size === 1 ? [...slot[side]][0] : undefined;
  const props = list(properties);
  const rule = cause.rule;
  const target = rule && {
    ...(rule.sheet && { file: rule.sheet }),
    ...(rule.line && { line: rule.line }),
    selector: rule.selector,
  };
  let title: string;
  let fix: Fix | undefined;
  if (cause.kind === "lost" && rule) {
    const instead = other("heads");
    title = `\`${rule.selector}\` (${loc(rule)}) no longer sets ${props}${instead ? (instead === "none" ? "; nothing does now" : `; \`${instead.split("@")[0]}\` wins instead`) : ""}`;
    const add: Record<string, string> = {};
    for (const c of changes) add[c.property] ??= c.before;
    fix = {
      text: `\`${rule.selector}\` (${loc(rule)}) set ${props} on these elements and no longer applies. If that's not intended, restore it for them: ${Object.entries(
        add,
      )
        .map(([p, v]) => `${p}: ${v}`)
        .join("; ")}.`,
      ...target,
      add,
    };
  } else if (cause.kind === "won" && rule) {
    const over = other("bases");
    title = `\`${rule.selector}\` (${loc(rule)}) now sets ${props}${over && over !== "none" ? ` over \`${over.split("@")[0]}\`` : ""}`;
    fix = {
      text: `\`${rule.selector}\` now wins ${props} on these elements. If it shouldn't, narrow its selector or lower its specificity below what won before.`,
      ...target,
    };
  } else if (cause.kind === "shifted")
    title = `${props}: ${cause.base ? where(cause.base) : "no declaration"} -> ${cause.head ? where(cause.head) : "no declaration"}`;
  else
    title = `${changes[0].property}: ${changes[0].before} -> ${changes[0].after}`;
  const id = shortHash(`${slot.key}|${[...properties].sort().join()}`);
  const shown = changes
    .slice(0, 3)
    .map((c) => `${c.property} ${c.before} -> ${c.after}`)
    .join("; ");
  const alt = `${elements.length} element(s) on ${list(pages, 3)}: ${shown}${changes.length > 3 ? `; and ${changes.length - 3} more change(s)` : ""}${slot.invisible ? ` (invisible: ${slot.invisible})` : ""}${pixels ? `; pixels differ on ${pixels.differ} of ${checked.length}` : ""}${deltaE ? `, CIEDE2000 up to ${deltaE.max.toFixed(1)} (mean ${deltaE.mean.toFixed(1)})` : ""}.`;
  return {
    id,
    verdict,
    ...(slot.invisible && { invisible: slot.invisible }),
    title,
    cause,
    changes,
    elements,
    pages,
    ...(pixels && { pixels }),
    ...(deltaE && { deltaE }),
    ...(fix && { fix }),
    ...(slot.commits.size && {
      commits: [...slot.commits].map(([sha, subject]) => ({ sha, subject })),
    }),
    alt,
  };
}

/** The report for a run: its cards and a count per verdict. */
export function buildReport(
  command: Report["command"],
  base: string,
  head: string,
  cards: Card[],
): Report {
  const summary: Record<Verdict, number> = {
    visible: 0,
    imperceptible: 0,
    invisible: 0,
  };
  for (const c of cards) summary[c.verdict]++;
  return { schema: REPORT_SCHEMA, command, base, head, summary, cards };
}
