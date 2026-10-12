// Change cards: a compare's changes grouped by root cause, the rule that
// changed and so stopped or started winning, each with what a person or an
// agent needs to act on it without opening a snapshot. One model, rendered
// as JSON (`crassus/report@1`), HTML, Markdown, a terminal summary and SARIF.
import {
  type DeltaE,
  type Explained,
  IMPERCEPTIBLE,
  type Inspected,
  type PageDiff,
  type PropertyChange,
  type TokenChange,
  tokenChangeOf,
  type Winner,
} from "./snapshot-diff";
import { shortHash } from "./util";

const REPORT_SCHEMA = "crassus/report@1";

/**
 * `token-detached`: a property that followed a design token on base no
 * longer does, whatever its pixels (with `compare`'s `tokens`).
 */
export type Verdict =
  | "token-detached"
  | "visible"
  | "imperceptible"
  | "invisible";

export interface Cause {
  /**
   * `lost`: a rule that differs between the sides set these on base and
   * no longer does. `won`: one now sets them on head. `edited`: the same
   * rule wins on both sides, with other values. `shifted`: the
   * winners differ but neither rule changed (the cascade moved around
   * them). `value`: no winners known (run with `explain`). `token`:
   * no value changed, but what drives it did (see `Card.tokens`).
   */
  kind: "lost" | "won" | "edited" | "shifted" | "value" | "token";
  /** The rule that changed, for `lost`, `won` and `edited`. */
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
  /** Why no one can see it, for an invisible card: its reasons, most common first. */
  invisible?: string;
  title: string;
  cause: Cause;
  changes: CardChange[];
  /** Elements, first page first. */
  elements: CardElement[];
  /** Elements per selector, when the cause's rule matched through several. */
  selectors?: Record<string, number>;
  pages: string[];
  pixels?: { differ: number; same: number; imperceptible: number };
  deltaE?: DeltaE;
  fix?: Fix;
  /** With `bisect`: the commits the change came in. */
  commits?: { sha: string; subject: string }[];
  /** The card in one sentence, for readers without the images. */
  alt: string;
  /** Set when `crassus.approved.json` approves it: an intended change. */
  approved?: true;
  /** With token tracing: its changes that stopped following a token, or follow others. */
  tokens?: {
    detached: number;
    retokened: number;
    from: string[];
    to: string[];
  };
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
  /** Cards per verdict, and how many of all are approved. */
  summary: Record<Verdict, number> & { approved: number };
  cards: Card[];
}

const APPROVED_SCHEMA = "crassus/approved@1";

/** `crassus.approved.json`: intended changes, by card. */
export interface Approvals {
  schema: typeof APPROVED_SCHEMA;
  approved: {
    id: string;
    /** For the reader: the card's title when approved. */
    title: string;
    /** The changes approved: a card with any other isn't. */
    changes: { property: string; before: string; after: string }[];
  }[];
}

export const emptyApprovals = (): Approvals => ({
  schema: APPROVED_SCHEMA,
  approved: [],
});

const changeKey = (c: { property: string; before: string; after: string }) =>
  `${c.property}\0${c.before}\0${c.after}`;

/**
 * Whether `card` is approved: its cause was, with every change it makes
 * now. The same cause on more elements stays approved; new values don't.
 */
export function isApproved(card: Card, approvals: Approvals): boolean {
  const entry = approvals.approved.find((a) => a.id === card.id);
  if (!entry) return false;
  const ok = new Set(entry.changes.map(changeKey));
  return card.changes.every((c) => ok.has(changeKey(c)));
}

/** `approvals` with `cards` added (replacing earlier entries for them), sorted by id. */
export function approve(approvals: Approvals, cards: Card[]): Approvals {
  const ids = new Set(cards.map((c) => c.id));
  return {
    schema: APPROVED_SCHEMA,
    approved: [
      ...approvals.approved.filter((a) => !ids.has(a.id)),
      ...cards.map((c) => ({
        id: c.id,
        title: c.title,
        changes: c.changes.map(({ property, before, after }) => ({
          property,
          before,
          after,
        })),
      })),
    ].sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}

/** Visible or token-detached cards no approval covers: what fails a run. */
export const blocking = (cards: Card[]) =>
  cards.filter(
    (c) =>
      (c.verdict === "visible" || c.verdict === "token-detached") &&
      !c.approved,
  );

type Page = { file: string } & Pick<PageDiff, "changed"> & Inspected;

/** `sheet:line`, or the sheet alone. */
export const loc = (w: Winner) => `${w.sheet}${w.line ? `:${w.line}` : ""}`;
/** `selector (sheet:line, inherited)`. */
export const where = (w: Winner) =>
  `${w.selector} (${loc(w)}${w.inherited ? ", inherited" : ""})`;
// A rule is one cause whichever of its selectors matched.
const winnerKey = (w: Winner | null | undefined) =>
  w ? `${w.list ?? w.selector}@${w.sheet}${w.inherited ? "^" : ""}` : "none";
const list = (items: string[], max = 4) =>
  items.slice(0, max).join(", ") +
  (items.length > max ? ` and ${items.length - max} more` : "");

interface Slot {
  key: string;
  cause: Cause;
  /** Invisible changes' reasons, counted. */
  reasons?: Map<string, number>;
  /** Elements per selector of the cause's rule that matched them. */
  selectors: Map<string, number>;
  commits: Map<string, string>;
  changes: Map<string, CardChange>;
  elements: Map<string, CardElement>;
  bases: Set<string>;
  heads: Set<string>;
  tokens?: {
    detached: number;
    retokened: number;
    from: Set<string>;
    to: Set<string>;
  };
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
  const add = (
    run: (typeof runs)[number],
    page: Page,
    path: string,
    c: PropertyChange,
    cause: Cause,
    key: string,
    invisible: string | undefined,
    explained?: Explained,
  ) => {
    let slot = slots.get(key);
    if (!slot) {
      slot = {
        key,
        cause,
        selectors: new Map(),
        commits: new Map(),
        changes: new Map(),
        elements: new Map(),
        bases: new Set(),
        heads: new Set(),
      };
      slots.set(key, slot);
    }
    if (invisible) {
      slot.reasons ??= new Map();
      slot.reasons.set(invisible, (slot.reasons.get(invisible) ?? 0) + 1);
    }
    for (const commit of run.commits ?? [])
      slot.commits.set(commit.sha, commit.subject);
    if (explained) {
      slot.bases.add(winnerKey(explained.base));
      slot.heads.add(winnerKey(explained.head));
    }
    const token = tokenChangeOf(page.tokens, path, c);
    if (token) {
      slot.tokens ??= {
        detached: 0,
        retokened: 0,
        from: new Set(),
        to: new Set(),
      };
      slot.tokens[token.head.length ? "retokened" : "detached"]++;
      for (const t of token.base) slot.tokens.from.add(t);
      for (const t of token.head) slot.tokens.to.add(t);
    }
    const ck = changeKey(c);
    const change = slot.changes.get(ck) ?? {
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
    slot.changes.set(ck, change);
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
      const s = cause.rule?.selector;
      if (s !== undefined)
        slot.selectors.set(s, (slot.selectors.get(s) ?? 0) + 1);
      slot.elements.set(elKey, el);
    }
    if (!el.properties.includes(c.property)) el.properties.push(c.property);
  };
  for (const run of runs)
    for (const page of run.pages) {
      for (const [path, changes] of Object.entries(page.changed)) {
        const explained = page.explain?.[path] ?? {};
        const own = (property: string): Cause | undefined => {
          const e = explained[property];
          if (e?.base?.changed)
            return e.head?.changed && winnerKey(e.base) === winnerKey(e.head)
              ? { kind: "edited", rule: e.head }
              : { kind: "lost", rule: e.base };
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
          // A detached token shows wherever the element does: no card apart.
          const token = tokenChangeOf(page.tokens, path, c);
          const invisible =
            token && token.head.length === 0 ? undefined : c.invisible;
          const key = [
            cause.kind,
            // However it reached the element, the same rule is one cause.
            cause.rule
              ? winnerKey({ ...cause.rule, inherited: undefined })
              : cause.kind === "shifted"
                ? `${winnerKey(cause.base)}>${winnerKey(cause.head)}`
                : `${c.property}:${c.before}>${c.after}`,
            // One invisible card per cause, whatever hides each element.
            invisible ? "invisible" : "",
          ].join("|");
          add(run, page, path, c, cause, key, invisible, e);
        }
      }
      // What drives a value changed while the value didn't: one change per
      // element and token change, its properties folded.
      for (const [path, props] of Object.entries(page.tokens ?? {})) {
        const changed = page.changed[path] ?? [];
        const covered = new Set(
          changed.flatMap((c) => [c.property, ...(c.aliases ?? [])]),
        );
        const by = new Map<string, [string, TokenChange][]>();
        for (const [property, t] of Object.entries(props)) {
          if (covered.has(property)) continue;
          const k = `${t.base.join()}>${t.head.join()}`;
          by.set(k, [...(by.get(k) ?? []), [property, t]]);
        }
        for (const [k, list] of by) {
          const names = list.map(([p]) => p).sort();
          const property = names.includes("color") ? "color" : names[0];
          const t = list.find(([p]) => p === property)?.[1] ?? list[0][1];
          const value = t.value ?? "";
          const c: PropertyChange = {
            property,
            before: value,
            after: value,
            ...(names.length > 1 && {
              aliases: names.filter((n) => n !== property),
            }),
          };
          add(
            run,
            page,
            path,
            c,
            { kind: "token" },
            `token|${property}|${k}|`,
            undefined,
          );
        }
      }
    }
  const order: Record<Verdict, number> = {
    "token-detached": 0,
    visible: 1,
    imperceptible: 2,
    invisible: 3,
  };
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
  const invisible =
    slot.reasons &&
    [...slot.reasons]
      .sort((a, b) => b[1] - a[1])
      .map(([why]) => why)
      .join("; ");
  // A detached token is a broken contract even where it's hidden now.
  const verdict: Verdict = slot.tokens?.detached
    ? "token-detached"
    : invisible
      ? "invisible"
      : slot.cause.kind === "token" ||
          (pixels &&
            checked.length === elements.length &&
            !checked.some(perceptible))
        ? "imperceptible"
        : "visible";
  const cause = slot.cause;
  // Winners every element shares, worth naming.
  const other = (side: "bases" | "heads") =>
    slot[side].size === 1 ? [...slot[side]][0] : undefined;
  const props = list(properties);
  const rule = cause.rule;
  // A rule matched through several of its selectors is named by them all.
  const named =
    slot.selectors.size > 1
      ? [...slot.selectors.keys()].join(", ")
      : rule?.selector;
  const target = rule && {
    ...(rule.sheet && { file: rule.sheet }),
    ...(rule.line && { line: rule.line }),
    selector: rule.selector,
  };
  const restore = () => {
    const add: Record<string, string> = {};
    for (const c of changes) add[c.property] ??= c.before;
    const values = Object.entries(add)
      .map(([p, v]) => `${p}: ${v}`)
      .join("; ");
    return { add, values };
  };
  let title: string;
  let fix: Fix | undefined;
  if (cause.kind === "lost" && rule) {
    const instead = other("heads");
    const { add, values } = restore();
    title = `\`${named}\` (${loc(rule)}) no longer sets ${props}${instead ? (instead === "none" ? "; nothing does now" : `; \`${instead.split("@")[0]}\` wins instead`) : ""}`;
    fix = {
      text: `\`${named}\` (${loc(rule)}) set ${props} on these elements and no longer applies. If that's not intended, restore it for them: ${values}.`,
      ...target,
      add,
    };
  } else if (cause.kind === "edited" && rule) {
    const one = changes.length === 1 && changes[0];
    const { add, values } = restore();
    title = `\`${named}\` (${loc(rule)}) changes ${one ? `${one.property} from ${one.before} to ${one.after}` : props}`;
    fix = {
      text: `\`${named}\` (${loc(rule)}) now gives ${props} other values. If that's not intended, restore them: ${values}.`,
      ...target,
      add,
    };
  } else if (cause.kind === "won" && rule) {
    const over = other("bases");
    title = `\`${named}\` (${loc(rule)}) now sets ${props}${over && over !== "none" ? ` over \`${over.split("@")[0]}\`` : ""}`;
    fix = {
      text: `\`${named}\` now wins ${props} on these elements. If it shouldn't, narrow its selector or lower its specificity below what won before.`,
      ...target,
    };
  } else if (cause.kind === "token" && slot.tokens) {
    const from = [...slot.tokens.from].join(", ");
    const to = [...slot.tokens.to].join(", ");
    const s = properties.length === 1 ? "s" : "";
    title = to
      ? `${props} follow${s} ${to} instead of ${from}`
      : `${props} no longer follow${s} ${from}`;
  } else if (cause.kind === "shifted")
    title = `${props}: ${cause.base ? where(cause.base) : "no declaration"} -> ${cause.head ? where(cause.head) : "no declaration"}`;
  else
    title = `${changes[0].property}: ${changes[0].before} -> ${changes[0].after}`;
  const id = shortHash(`${slot.key}|${[...properties].sort().join()}`);
  const shown = changes
    .slice(0, 3)
    .map((c) => `${c.property} ${c.before} -> ${c.after}`)
    .join("; ");
  const alt = `${elements.length} element(s) on ${list(pages, 3)}: ${shown}${changes.length > 3 ? `; and ${changes.length - 3} more change(s)` : ""}${invisible ? ` (invisible: ${invisible})` : ""}${pixels ? `; pixels differ on ${pixels.differ} of ${checked.length}` : ""}${deltaE ? `, CIEDE2000 up to ${deltaE.max.toFixed(1)} (mean ${deltaE.mean.toFixed(1)})` : ""}.`;
  return {
    id,
    verdict,
    ...(invisible && { invisible }),
    ...(slot.selectors.size > 1 && {
      selectors: Object.fromEntries(slot.selectors),
    }),
    title,
    cause,
    changes,
    elements,
    pages,
    ...(pixels && { pixels }),
    ...(deltaE && { deltaE }),
    ...(fix && { fix }),
    ...(slot.tokens && {
      tokens: {
        detached: slot.tokens.detached,
        retokened: slot.tokens.retokened,
        from: [...slot.tokens.from].sort(),
        to: [...slot.tokens.to].sort(),
      },
    }),
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
  approvals?: Approvals,
): Report {
  const summary = {
    "token-detached": 0,
    visible: 0,
    imperceptible: 0,
    invisible: 0,
    approved: 0,
  };
  for (const c of cards) {
    summary[c.verdict]++;
    if (approvals && isApproved(c, approvals)) {
      c.approved = true;
      summary.approved++;
    }
  }
  return { schema: REPORT_SCHEMA, command, base, head, summary, cards };
}
