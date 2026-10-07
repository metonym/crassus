/**
 * Computed-style snapshots. Without CDP (WebKit), states can be forced by
 * rewriting each state rule's selector in place (`:hover` ->
 * `[data-cr-hover]`: same specificity, same order) and toggling the
 * attribute, and reduced motion emulated by rewriting media conditions.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Snapshot } from "../core/snapshot-diff";
import { INTERACTIVE, MAX_STATE_ELEMENTS, STATE_SETS } from "../page/states";
import { PAGE_HELPERS } from "./page-helpers";
import { type PageJob, pageJobs } from "./serve";
import {
  type EngineName,
  reduceMotion,
  runPool,
  View,
  type Viewport,
  viewportName,
  viewportsOf,
  waitReady,
} from "./view";

const TRAILING_SEMICOLON_RE = /;$/;
const VIEWPORT_RE = /^\d+x\d+$/;
const JSON_EXT_RE = /\.json$/;

const FREEZE =
  "*, *::before, *::after { transition: none !important; animation: none !important; }";

/** In-page: state-rule rewriting, reduced-motion emulation, forced states. */
const CR_HELPERS = `
  (() => {
    const STATES = ${JSON.stringify(STATE_SETS)};
    const TEST = /:(focus-visible|focus-within|hover|focus|active)(?![\\w-])/;
    const REPLACE = /:(focus-visible|focus-within|hover|focus|active)(?![\\w-])/g;
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
        // The UA focus ring is in the user-agent sheet, out of the CSSOM's
        // reach. Re-add Chromium's at zero specificity, first in author
        // order, so author outline rules still beat it.
        const ua = document.createElement("style");
        ua.textContent = ":where([data-cr-focus-visible]) { outline: auto 1px -webkit-focus-ring-color; }" +
          ":where(input[type=checkbox i][data-cr-focus-visible], input[type=radio i][data-cr-focus-visible]) { outline-offset: 2px; }" +
          ":where(button[data-cr-active], input[type=button i][data-cr-active], input[type=submit i][data-cr-active], input[type=reset i][data-cr-active]) { border-style: inset; }";
        document.head.prepend(ua);
        // In place, not as added twins: a twin can't stop \`:not(:focus)\`
        // from matching.
        each((r) => {
          if (!TEST.test(r.selectorText)) return;
          r.selectorText = r.selectorText.replace(REPLACE, (_, s) => "[data-cr-" + s + "]");
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
            // Forced focus also makes the element and its ancestors match
            // :focus-within, as CDP's forcePseudoState does.
            const within = state === "focus" ? [] : null;
            for (let a = el; within && a; a = a.parentElement) within.push(a);
            for (const s of names) el.setAttribute("data-cr-" + s, "");
            for (const a of within || []) a.setAttribute("data-cr-focus-within", "");
            Object.assign(out, window.__ccs.snapshotState(i, state));
            for (const s of names) el.removeAttribute("data-cr-" + s);
            for (const a of within || []) a.removeAttribute("data-cr-focus-within");
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
  /** One viewport (default 1280 × 900). Prefer `viewports`. */
  width?: number;
  height?: number;
  /**
   * Captures every page at each. Default: the one `width` × `height`. With
   * more than one, files are named `<name>.<theme>.<W>x<H>.json`.
   */
  viewports?: Viewport[];
  /**
   * Waits after load until this selector matches (polled, up to
   * `readyTimeoutMs`), before `settleMs`. A page that never matches is
   * still captured, and listed in `notReady`.
   */
  readySelector?: string;
  /** Default 5000 ms. */
  readyTimeoutMs?: number;
  /** After load. Default 500 ms. */
  settleMs?: number;
}

/** `<name>.<theme>.json`, or `<name>.<theme>.<W>x<H>.json` with `viewport`. */
const snapshotFile = (
  job: Pick<PageJob, "name" | "theme">,
  viewport?: Viewport,
) =>
  `${job.name}.${job.theme}${viewport ? `.${viewportName(viewport)}` : ""}.json`;

/** Reverses `snapshotFile`. */
export function parseSnapshotFile(file: string): {
  fixture: string;
  theme: string;
  viewport?: string;
} {
  const parts = file.replace(JSON_EXT_RE, "").split(".");
  const viewport =
    parts.length > 2 && VIEWPORT_RE.test(parts.at(-1) ?? "")
      ? parts.pop()
      : undefined;
  const theme = parts.length > 1 ? (parts.pop() ?? "") : "";
  return { fixture: parts.join("."), theme, ...(viewport && { viewport }) };
}

async function capturePage(
  view: View,
  url: string,
  opts: Pick<
    CaptureOptions,
    "states" | "emulate" | "settleMs" | "readySelector" | "readyTimeoutMs"
  >,
): Promise<{ snap: Snapshot; ready: boolean }> {
  if (opts.emulate === "cdp") await reduceMotion(view);
  await view.navigate(url);
  const ready = opts.readySelector
    ? await waitReady(view, opts.readySelector, opts.readyTimeoutMs)
    : true;
  // evaluate() takes an expression: drop the statement terminator.
  await view.evaluate(PAGE_HELPERS.trim().replace(TRAILING_SEMICOLON_RE, ""));
  await view.evaluate(CR_HELPERS);
  if (opts.emulate === "cssom")
    await view.evaluate("window.__cr.reducedMotion()");
  await Bun.sleep(opts.settleMs ?? 500);
  const snap = await view.evaluate<Snapshot>("window.__ccs.snapshot()");
  if (!opts.states) return { snap, ready };

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
    return { snap, ready };
  }

  await view.cdp("DOM.enable");
  await view.cdp("CSS.enable");
  const { root } = await view.cdp<{ root: { nodeId: number } }>(
    "DOM.getDocument",
    {
      depth: 0,
    },
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
  return { snap, ready };
}

export async function capture(
  opts: CaptureOptions,
): Promise<{ pages: number; ms: number; notReady: string[] }> {
  await mkdir(opts.outDir, { recursive: true });
  const viewports = viewportsOf(opts);
  const jobs = pageJobs(opts.baseUrl, opts.fixtures, opts.themes, viewports);
  const started = performance.now();
  const ready = await runPool(
    jobs,
    opts.concurrency,
    () =>
      new View({
        engine: opts.engine,
        chromePath: opts.chromePath,
        ...viewports[0],
      }),
    async (view, job) => {
      await view.resize(job.viewport);
      const { snap, ready } = await capturePage(view, job.url, opts);
      await Bun.write(
        path.join(
          opts.outDir,
          snapshotFile(job, viewports.length > 1 ? job.viewport : undefined),
        ),
        JSON.stringify(snap),
      );
      return ready;
    },
  );
  return {
    pages: jobs.length,
    ms: performance.now() - started,
    notReady: jobs.filter((_, i) => !ready[i]).map((j) => j.label),
  };
}
