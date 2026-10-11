import { mkdir, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { type StateTrigger, stateTriggers } from "../core/impact";
import { NTH, type Snapshot } from "../core/snapshot-diff";
import { resolvePath } from "../page/resolve-path";
import {
  INTERACTIVE,
  MAX_STATE_ELEMENTS,
  STATE_RE,
  STATE_SETS,
} from "../page/states";
import { PAGE_HELPERS } from "./page-helpers";
import {
  type EngineName,
  type PageJob,
  type View,
  type Viewport,
  viewportName,
  viewportsOf,
  visitPages,
} from "./view";

const VIEWPORT_RE = /^\d+x\d+$/;
const SNAPSHOT_EXT_RE = /\.json(?:\.gz)?$/;

const FREEZE =
  "*, *::before, *::after { transition: none !important; animation: none !important; }";

// Without CDP (WebKit), states are forced by rewriting state selectors to
// `[data-cr-*]` in place (same specificity and order) and toggling the
// attribute; reduced motion by rewriting media conditions.
const CR_HELPERS = `
  (() => {
    const STATES = ${JSON.stringify(STATE_SETS)};
    const resolvePath = ${resolvePath.toString()};
    const each = (fn) => {
      const visit = (list) => {
        for (let i = list.length - 1; i >= 0; i--) {
          const r = list[i];
          if (r instanceof CSSStyleRule) fn(r, list, i);
          else if (r.cssRules) visit(r.cssRules);
        }
      };
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }
        visit(rules);
      }
    };
    window.__cr = {
      twinStates() {
        let n = 0;
        // The UA focus ring is out of the CSSOM's reach: re-add Chromium's at
        // zero specificity, first in author order, so author rules beat it.
        const ua = document.createElement("style");
        ua.textContent = ":where([data-cr-focus-visible]) { outline: auto 1px -webkit-focus-ring-color; }" +
          ":where(input[type=checkbox i][data-cr-focus-visible], input[type=radio i][data-cr-focus-visible]) { outline-offset: 2px; }" +
          ":where(button[data-cr-active], input[type=button i][data-cr-active], input[type=submit i][data-cr-active], input[type=reset i][data-cr-active]) { border-style: inset; }";
        document.head.prepend(ua);
        // Not as added twins: a twin can't stop \`:not(:focus)\` matching.
        each((r) => {
          const sel = r.selectorText.replace(${STATE_RE}, (_, s) => "[data-cr-" + s + "]");
          if (sel === r.selectorText) return;
          r.selectorText = sel;
          n++;
        });
        return n;
      },
      reducedMotion() {
        let n = 0;
        const visit = (list) => {
          for (const r of list) {
            if (r instanceof CSSMediaRule && /prefers-reduced-motion/.test(r.media.mediaText)) {
              r.media.mediaText = /no-preference/.test(r.media.mediaText) ? "not all" : "all";
              n++;
            }
            if (r.cssRules) visit(r.cssRules);
          }
        };
        for (const sheet of document.styleSheets) {
          try { visit(sheet.cssRules); } catch {}
        }
        return n;
      },
      // Running animations make two captures of one page differ: infinite
      // ones are paused at their start, finite ones finished, as if settled.
      freezeAnimations() {
        let n = 0;
        // What animations style, finished ones included: stopping them
        // (the state phase's freeze) changes those values.
        window.__crAnimated = new Set();
        for (const a of document.getAnimations()) {
          const target = a.effect && a.effect.target;
          if (target) window.__crAnimated.add(target);
          if (a.playState === "finished") continue;
          try {
            if (a.effect?.getComputedTiming().endTime === Infinity) {
              a.pause();
              a.currentTime = 0;
            } else a.finish();
            n++;
          } catch {}
        }
        return n;
      },
      // The states a user can put each tagged element in: no :focus or
      // :active when disabled, no :focus when it can't take focus, and none
      // when inert. Read statically: focus() would run the page's handlers.
      reachable(n) {
        const out = [];
        for (let i = 0; i < n; i++) {
          const el = document.querySelector('[data-ccs-idx="' + i + '"]');
          if (!el || el.closest("[inert]")) {
            out.push([]);
            continue;
          }
          const disabled = el.matches(":disabled");
          const visible = !el.checkVisibility || el.checkVisibility({ visibilityProperty: true });
          // tabIndex is 0 on a link without href, which can't take focus.
          const focusable = !disabled && visible && (el.hasAttribute("tabindex") || el.isContentEditable ||
            (el.tabIndex >= 0 && !el.matches("a:not([href]), area:not([href]), input[type=hidden i]")));
          out.push(Object.keys(STATES).filter((s) => s === "hover" || (s === "active" ? !disabled : focusable)));
        }
        window.__crReach = out;
        return out;
      },
      // Marks the element a snapshot key names (data-cr-target) and, for a
      // state key, the element whose forced state recorded it (data-cr-forced):
      // the last tagged one that reaches the state and is the element, an
      // ancestor of it, or (for \`^\`) its child.
      target(key) {
        for (const a of ["data-cr-target", "data-cr-forced"])
          for (const e of document.querySelectorAll("[" + a + "]")) e.removeAttribute(a);
        const el = resolvePath(key, document.documentElement);
        if (!el) return null;
        el.setAttribute("data-cr-target", "");
        const m = /@(hover|focus|active)(\\^?)(?:::before|::after)?$/.exec(key);
        if (!m) return { state: null, forced: null };
        let forced = null;
        for (const t of document.querySelectorAll("[data-ccs-idx]")) {
          const reach = (window.__crReach || [])[Number(t.getAttribute("data-ccs-idx"))] || [];
          if (!reach.includes(m[1])) continue;
          if (m[2] ? t.parentElement === el : t === el || t.contains(el)) forced = t;
        }
        if (!forced) return null;
        forced.setAttribute("data-cr-forced", "");
        return { state: m[1], forced: Number(forced.getAttribute("data-ccs-idx")) };
      },
      // Each key's element as a CSS selector a person can paste, and with
      // \`html\`, its markup (instrumentation stripped) and the opening tags
      // of its ancestors.
      where(keys, html) {
        const MARK = / data-(?:ccs-idx|cr-[\\w-]+)(?:="[^"]*")?/g;
        const open = (el) => el.cloneNode(false).outerHTML.replace(/<\\/[^>]+>$/, "").replace(MARK, "");
        return keys.map((key) => {
          const el = resolvePath(key, document.documentElement);
          if (!el) return null;
          const parts = [];
          for (let e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement)
            parts.unshift(e.localName + ":nth-child(" + (Array.prototype.indexOf.call(e.parentElement.children, e) + 1) + ")");
          const pseudo = /::(before|after)$/.exec(key);
          const out = { selector: ["body", ...parts].join(" > ") + (pseudo ? pseudo[0] : "") };
          if (html) {
            // Without comments: frameworks' empty anchors (Svelte's <!---->).
            out.html = el.outerHTML.replace(MARK, "").replace(/<!--[\\s\\S]*?-->/g, "").slice(0, 20000);
            out.ancestors = [];
            for (let a = el.parentElement; a; a = a.parentElement) out.ancestors.unshift(open(a));
          }
          return out;
        });
      },
      // The target's box in document coordinates, padded to at least 24 × 16
      // and by 8 px for outlines and shadows; null when it renders no box
      // (its 0 × 0 rect would sit at the page's origin, over other content).
      rect() {
        const el = document.querySelector("[data-cr-target]");
        if (el.getClientRects().length === 0) return null;
        const r = el.getBoundingClientRect();
        const w = Math.max(r.width, 24) + 16;
        const h = Math.max(r.height, 16) + 16;
        return {
          x: Math.max(0, r.left + window.scrollX + r.width / 2 - w / 2),
          y: Math.max(0, r.top + window.scrollY + r.height / 2 - h / 2),
          width: w,
          height: h,
        };
      },
      allStates(reach) {
        const out = {};
        for (let i = 0; i < reach.length; i++) {
          const el = document.querySelector('[data-ccs-idx="' + i + '"]');
          if (!el) continue;
          for (const [state, names] of Object.entries(STATES)) {
            if (!reach[i].includes(state)) continue;
            // As in CDP, forced focus also matches :focus-within up the tree.
            const within = [];
            if (state === "focus") for (let a = el; a; a = a.parentElement) within.push(a);
            for (const s of names) el.setAttribute("data-cr-" + s, "");
            for (const a of within) a.setAttribute("data-cr-focus-within", "");
            Object.assign(out, window.__ccs.snapshotState(i, state));
            for (const s of names) el.removeAttribute("data-cr-" + s);
            for (const a of within) a.removeAttribute("data-cr-focus-within");
          }
        }
        return out;
      },
    };
  })()
`;

export interface CaptureOptions {
  baseUrl: string;
  fixtures: string[];
  themes: string[];
  outDir: string;
  engine: EngineName;
  states: "cdp" | "rewrite" | false;
  emulate: "cdp" | "cssom";
  concurrency: number;
  chromePath?: string;
  /** `<html>` attribute set to the theme (with `serveFixtures`). Default `theme`; `null`: none. */
  themeAttribute?: string | null;
  /** One viewport (default 1280 × 900). Prefer `viewports`. */
  width?: number;
  height?: number;
  /** With several, files are named `<name>.<theme>.<W>x<H>.json.gz`. */
  viewports?: Viewport[];
  /**
   * Polled after load (up to `readyTimeoutMs`), before `settleMs`. A page it
   * never matches on is still captured, and listed in `notReady`.
   */
  readySelector?: string;
  /** Default 5000 ms. */
  readyTimeoutMs?: number;
  /** After load. Default 500 ms. */
  settleMs?: number;
  /**
   * Default true: force a state (CDP mode) only on elements some rule's
   * state applies to, and read the others unforced, which gives the same
   * records (focus is always forced: the user agent's focus ring).
   */
  stateIndex?: boolean;
}

export const snapshotFile = (job: PageJob, several: boolean) =>
  `${job.name}.${job.theme}${several ? `.${viewportName(job.viewport)}` : ""}.json.gz`;

/** Reverses `snapshotFile`. */
export function parseSnapshotFile(file: string): {
  fixture: string;
  theme: string;
  viewport?: string;
} {
  const parts = file.replace(SNAPSHOT_EXT_RE, "").split(".");
  const viewport =
    parts.length > 2 && VIEWPORT_RE.test(parts.at(-1) ?? "")
      ? parts.pop()
      : undefined;
  const theme = parts.length > 1 ? (parts.pop() ?? "") : "";
  return { fixture: parts.join("."), theme, ...(viewport && { viewport }) };
}

/**
 * A snapshot file's JSON, before gzip. Most elements share their computed
 * style with others, so each distinct style is stored once.
 */
interface SnapshotFile {
  props: string[];
  /** Values in `props` order; `null` where the record lacks the property. */
  styles: (string | null)[][];
  /**
   * Element path, its index in `styles`, and (plain records) its index
   * among its parent's children, kept out of the style so it stays shared.
   */
  elements: [string, number, number?][];
}

export function encodeSnapshot(snap: Snapshot): Uint8Array<ArrayBuffer> {
  const props = [...new Set(Object.values(snap).flatMap(Object.keys))].filter(
    (p) => p !== NTH,
  );
  const index = new Map<string, number>();
  const file: SnapshotFile = { props, styles: [], elements: [] };
  for (const [path, record] of Object.entries(snap)) {
    const style = props.map((p) => record[p] ?? null);
    const key = JSON.stringify(style);
    let i = index.get(key);
    if (i === undefined) {
      i = file.styles.push(style) - 1;
      index.set(key, i);
    }
    file.elements.push(
      record[NTH] ? [path, i, Number(record[NTH])] : [path, i],
    );
  }
  return Bun.gzipSync(JSON.stringify(file));
}

/**
 * A `capture` file's records (elements with the same style share one
 * record object), and each element's index among its parent's children,
 * for `selectorOf`.
 */
export function decodeCapture(bytes: Uint8Array<ArrayBuffer>): {
  snapshot: Snapshot;
  nth: Record<string, number>;
} {
  const file: SnapshotFile = JSON.parse(
    new TextDecoder().decode(Bun.gunzipSync(bytes)),
  );
  const records = file.styles.map((style) => {
    const record: Record<string, string> = {};
    style.forEach((value, i) => {
      if (value !== null) record[file.props[i]] = value;
    });
    return record;
  });
  const snapshot: Snapshot = {};
  const nth: Record<string, number> = {};
  for (const [path, i, n] of file.elements) {
    snapshot[path] = records[i];
    if (n) nth[path] = n;
  }
  return { snapshot, nth };
}

export const decodeSnapshot = (bytes: Uint8Array<ArrayBuffer>): Snapshot =>
  decodeCapture(bytes).snapshot;

/** Reads one `capture` file (`.json.gz`). */
export async function readSnapshot(file: string): Promise<Snapshot> {
  return decodeSnapshot(await Bun.file(file).bytes());
}

/** Reads one `capture` file with its elements' child indexes. */
export async function readCapture(file: string) {
  return decodeCapture(await Bun.file(file).bytes());
}

type PageOptions = Pick<
  CaptureOptions,
  "states" | "emulate" | "settleMs" | "stateIndex"
> & {
  /** Custom-property prefix of the design tokens to trace (`--cds-`). */
  tokens?: string;
};

/** What a page's forced states cost (CDP mode). */
export interface StateStats {
  ms: number;
  /** CDP calls the state phase made. */
  cdpCalls: number;
  /** Element states forced, and read unforced as no rule used them there. */
  forced: number;
  copied: number;
}

/** Per element, the properties that track tokens, and which. */
export type TokenTrace = Record<string, Record<string, string[]>>;

/** Loads the helpers, waits `settleMs` and freezes animations: the page as `capture` reads it. */
export async function preparePage(
  view: View,
  opts: PageOptions,
  /** Longhands to record beyond those the page's stylesheets declare. */
  extraProps: string[] = [],
): Promise<void> {
  if (extraProps.length)
    await view.evaluate(`window.__crProps = ${JSON.stringify(extraProps)}`);
  await view.evaluate(PAGE_HELPERS);
  await view.evaluate(CR_HELPERS);
  if (opts.emulate === "cssom")
    await view.evaluate("window.__cr.reducedMotion()");
  await Bun.sleep(opts.settleMs ?? 500);
  await view.evaluate("window.__cr.freezeAnimations()");
}

/** Stops transitions and tags the elements whose states are forced: per element, the states it can reach. */
export async function tagStates(view: View): Promise<string[][]> {
  await view.evaluate(
    `(() => { const s = document.createElement("style"); s.textContent = ${JSON.stringify(FREEZE)}; document.head.append(s); })()`,
  );
  const n = await view.evaluate<number>(
    `window.__ccs.tagInteractive(${JSON.stringify(INTERACTIVE)}, ${MAX_STATE_ELEMENTS})`,
  );
  return view.evaluate<string[][]>(`window.__cr.reachable(${n})`);
}

/** What `compare` reads of a page: what the changed rules can reach. */
export interface PageScope {
  /** Relaxed selectors of the changed rules. */
  selectors: string[];
  /**
   * For the selectors that match on the page (their indexes), the
   * properties to read (null: all) and whether a box can move, in which
   * case every element is read.
   */
  plan(hits: number[]): { properties: string[] | null; layout: boolean };
}

/** How much of a page a scoped capture read. */
export interface ScopeRead {
  /** Elements the changed selectors matched, before descendants. */
  matched: number;
  /** Every element was read: a box can move, or `<html>` or `<body>` matched. */
  every: boolean;
}

/** One page as `capture` reads it; with `scope`, only what the change can reach. */
export async function capturePage(
  view: View,
  opts: PageOptions,
  extraProps: string[] = [],
  scope?: PageScope,
): Promise<{
  snapshot: Snapshot;
  read?: ScopeRead;
  tokens?: TokenTrace;
  /** The tokens traced: those with a color, length or font-stack value. */
  tokenNames?: string[];
  stats?: StateStats;
}> {
  await preparePage(view, opts, extraProps);
  let forced: number[] | null = null;
  let read: ScopeRead | undefined;
  if (scope) {
    const m = await view.evaluate<{
      hits: number[];
      all: boolean;
      elements: number;
    }>(`window.__ccs.match(${JSON.stringify(scope.selectors)})`);
    const { properties, layout } = scope.plan(m.hits);
    const every = m.all || layout;
    forced = await view.evaluate<number[] | null>(
      `window.__ccs.scope(${JSON.stringify(properties)}, ${every}, ${JSON.stringify(INTERACTIVE)}, ${MAX_STATE_ELEMENTS})`,
    );
    read = { matched: m.elements, every };
  }
  const snap = await view.evaluate<Snapshot>("window.__ccs.snapshot()");
  const traced =
    opts.tokens &&
    (await view.evaluate<{ tokens: string[]; tracked: TokenTrace }>(
      `window.__ccs.tokens(${JSON.stringify(opts.tokens)})`,
    ));
  const out = {
    snapshot: snap,
    ...(read && { read }),
    ...(traced && { tokens: traced.tracked, tokenNames: traced.tokens }),
  };
  if (!opts.states) return out;
  const reach = await tagStates(view);
  const n = reach.length;
  // Only the elements whose states can record what the change reaches.
  const indexes = forced ?? Array.from({ length: n }, (_, i) => i);

  if (opts.states === "rewrite") {
    await view.evaluate("window.__cr.twinStates()");
    const only = reach.map((r, i) => (forced && !forced.includes(i) ? [] : r));
    Object.assign(
      snap,
      await view.evaluate<Snapshot>(
        `window.__cr.allStates(${JSON.stringify(only)})`,
      ),
    );
    return out;
  }

  const started = performance.now();
  const stats = { ms: 0, cdpCalls: 0, forced: 0, copied: 0 };
  const cdp = <T>(method: string, params?: Record<string, unknown>) => {
    stats.cdpCalls++;
    return view.cdp<T>(method, params);
  };
  const matters = opts.stateIndex === false ? null : await stateIndex(view, n);
  // Read in order, so the last record of a key is the same as forcing
  // every state would leave: a run of unforced reads goes in one call.
  let pending: [number, string][] = [];
  // Unforced, a state's records are the plain ones: copied when the plain
  // snapshot has them all (it does unless the read was scoped), else read
  // in the page. State keys never collide with plain ones, so `snap` holds
  // the plain records throughout.
  const flush = async () => {
    if (!pending.length) return;
    const { keys, frozen } = await view.evaluate<{
      keys: [string, string][][] | null;
      frozen: Record<string, string>;
    }>(`window.__ccs.statePaths(${JSON.stringify(pending)})`);
    // The freeze stops transitions and animations: their values, as read.
    // Only plain records carry the element's index.
    const thaw = (r: Record<string, string>) => {
      const { [NTH]: _, ...out } = r;
      for (const p in frozen) if (p in out) out[p] = frozen[p];
      return out;
    };
    if (keys?.every((pairs) => pairs.every(([, from]) => snap[from]))) {
      for (const pairs of keys)
        for (const [to, from] of pairs)
          for (const pseudo of ["", "::before", "::after"])
            if (snap[from + pseudo])
              snap[to + pseudo] = thaw(snap[from + pseudo]);
    } else {
      Object.assign(
        snap,
        await view.evaluate<Snapshot>(
          `window.__ccs.snapshotStates(${JSON.stringify(pending)})`,
        ),
      );
    }
    stats.copied += pending.length;
    pending = [];
  };
  await cdp("DOM.enable");
  await cdp("CSS.enable");
  const { root } = await cdp<{ root: { nodeId: number } }>("DOM.getDocument", {
    depth: 0,
  });
  for (const i of indexes) {
    if (i >= n || reach[i].length === 0) continue;
    const states = Object.keys(STATE_SETS).filter((s) => reach[i].includes(s));
    const force = states.filter((s) => !matters || matters[i].includes(s));
    for (const s of states) if (!force.includes(s)) pending.push([i, s]);
    if (force.length === 0) continue;
    // biome-ignore lint/performance/noAwaitInLoops: in order, one view
    await flush();
    const { nodeId } = await cdp<{ nodeId: number }>("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: `[data-ccs-idx="${i}"]`,
    });
    if (!nodeId) continue;
    for (const state of force) {
      // biome-ignore lint/performance/noAwaitInLoops: one CDP call at a time per view
      await cdp("CSS.forcePseudoState", {
        nodeId,
        forcedPseudoClasses: STATE_SETS[state],
      });
      stats.forced++;
      Object.assign(
        snap,
        await view.evaluate<Snapshot>(
          `window.__ccs.snapshotState(${i}, "${state}")`,
        ),
      );
    }
    await cdp("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
  }
  await flush();
  await cdp("DOM.disable");
  await cdp("CSS.disable");
  stats.ms = performance.now() - started;
  return { ...out, stats };
}

// The user agent restyles these when hovered or active (a link's color, a
// button's border, an option's background), whatever the author's rules
// say; and any element when focused.
const UA_HOVER = "option";
const UA_ACTIVE =
  "a[href], area[href], button, input, select, textarea, summary, option";

/**
 * Per tagged element, the states forcing can change records of: those some
 * rule's state applies to there (`stateTriggers`), focus always.
 */
async function stateIndex(view: View, n: number): Promise<string[][]> {
  const selectors = await view.evaluate<string[]>(
    "window.__ccs.stateSelectors()",
  );
  const triggers = new Map<string, StateTrigger>();
  for (const sel of selectors)
    for (const t of stateTriggers(sel)) triggers.set(JSON.stringify(t), t);
  return view.evaluate<string[][]>(
    `window.__ccs.stateMatters(${JSON.stringify([...triggers.values()])}, ${n}, ${JSON.stringify({ hover: UA_HOVER, active: UA_ACTIVE })})`,
  );
}

/** Written last by `capture`: a directory without it is incomplete. */
export const MANIFEST = ".crassus-capture";

export interface CaptureManifest {
  format: 1;
  /** Snapshot files, sorted: what `diffSnapshots` reads. */
  files: string[];
  notReady: string[];
  engine: EngineName;
  states: CaptureOptions["states"];
  themes: string[];
  viewports: Viewport[];
}

/** Free space a capture leaves on its disk. */
const DISK_RESERVE = 512 * 1024 * 1024;
const mb = (bytes: number) => `${Math.ceil(bytes / 1024 / 1024)} MB`;

/** Stops before the disk fills, projecting the pages written so far over the rest. */
export async function checkDisk(
  dir: string,
  written: number,
  done: number,
  total: number,
) {
  if (done >= total) return;
  const { bavail, bsize } = await statfs(dir);
  const free = bavail * bsize;
  const needed = (written / done) * (total - done);
  if (needed + DISK_RESERVE > free)
    throw Object.assign(
      new Error(
        `not enough disk space for ${dir}: ${total - done} more page(s) need about ${mb(needed)}, and ${mb(free)} is free (keeping ${mb(DISK_RESERVE)})`,
      ),
      { code: "ENOSPC" },
    );
}

export async function capture(
  opts: CaptureOptions,
): Promise<{ pages: number; ms: number; notReady: string[] }> {
  await mkdir(opts.outDir, { recursive: true });
  // A stale manifest would vouch for a capture that fails.
  await rm(path.join(opts.outDir, MANIFEST), { force: true });
  const viewports = viewportsOf(opts);
  const several = viewports.length > 1;
  const total = opts.fixtures.length * opts.themes.length * viewports.length;
  const files: string[] = [];
  let written = 0;
  const r = await visitPages(opts, async (view, job) => {
    const { snapshot: snap } = await capturePage(view, opts);
    const file = snapshotFile(job, several);
    written += await Bun.write(
      path.join(opts.outDir, file),
      encodeSnapshot(snap),
    );
    files.push(file);
    await checkDisk(opts.outDir, written, files.length, total);
  });
  await Bun.write(
    path.join(opts.outDir, MANIFEST),
    JSON.stringify({
      format: 1,
      files: files.sort(),
      notReady: r.notReady,
      engine: opts.engine,
      states: opts.states,
      themes: opts.themes,
      viewports,
    } satisfies CaptureManifest),
  );
  return r;
}
