import { mkdir, rm, statfs } from "node:fs/promises";
import path from "node:path";
import type { Snapshot } from "../core/snapshot-diff";
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
      allStates(n) {
        const out = {};
        for (let i = 0; i < n; i++) {
          const el = document.querySelector('[data-ccs-idx="' + i + '"]');
          if (!el) continue;
          for (const [state, names] of Object.entries(STATES)) {
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
}

const snapshotFile = (job: PageJob, several: boolean) =>
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
  /** Element path and its index in `styles`, in document order. */
  elements: [string, number][];
}

export function encodeSnapshot(snap: Snapshot): Uint8Array<ArrayBuffer> {
  const props = [...new Set(Object.values(snap).flatMap(Object.keys))];
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
    file.elements.push([path, i]);
  }
  return Bun.gzipSync(JSON.stringify(file));
}

/** Elements with the same style share one record object. */
export function decodeSnapshot(bytes: Uint8Array<ArrayBuffer>): Snapshot {
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
  const snap: Snapshot = {};
  for (const [path, i] of file.elements) snap[path] = records[i];
  return snap;
}

/** Reads one `capture` file (`.json.gz`). */
export async function readSnapshot(file: string): Promise<Snapshot> {
  return decodeSnapshot(await Bun.file(file).bytes());
}

async function capturePage(
  view: View,
  opts: Pick<CaptureOptions, "states" | "emulate" | "settleMs">,
): Promise<Snapshot> {
  await view.evaluate(PAGE_HELPERS);
  await view.evaluate(CR_HELPERS);
  if (opts.emulate === "cssom")
    await view.evaluate("window.__cr.reducedMotion()");
  await Bun.sleep(opts.settleMs ?? 500);
  const snap = await view.evaluate<Snapshot>("window.__ccs.snapshot()");
  if (!opts.states) return snap;

  await view.evaluate(
    `(() => { const s = document.createElement("style"); s.textContent = ${JSON.stringify(FREEZE)}; document.head.append(s); })()`,
  );
  const n = await view.evaluate<number>(
    `window.__ccs.tagInteractive(${JSON.stringify(INTERACTIVE)}, ${MAX_STATE_ELEMENTS})`,
  );

  if (opts.states === "rewrite") {
    await view.evaluate("window.__cr.twinStates()");
    Object.assign(
      snap,
      await view.evaluate<Snapshot>(`window.__cr.allStates(${n})`),
    );
    return snap;
  }

  await view.cdp("DOM.enable");
  await view.cdp("CSS.enable");
  const { root } = await view.cdp<{ root: { nodeId: number } }>(
    "DOM.getDocument",
    { depth: 0 },
  );
  for (let i = 0; i < n; i++) {
    // biome-ignore lint/performance/noAwaitInLoops: one CDP call at a time per view
    const { nodeId } = await view.cdp<{ nodeId: number }>("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: `[data-ccs-idx="${i}"]`,
    });
    if (!nodeId) continue;
    for (const [state, forced] of Object.entries(STATE_SETS)) {
      // biome-ignore lint/performance/noAwaitInLoops: one CDP call at a time per view
      await view.cdp("CSS.forcePseudoState", {
        nodeId,
        forcedPseudoClasses: forced,
      });
      Object.assign(
        snap,
        await view.evaluate<Snapshot>(
          `window.__ccs.snapshotState(${i}, "${state}")`,
        ),
      );
    }
    await view.cdp("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
  }
  await view.cdp("DOM.disable");
  await view.cdp("CSS.disable");
  return snap;
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
    const snap = await capturePage(view, opts);
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
