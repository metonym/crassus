// `crassus reduce <id>`: the fewest declaration edits of a stylesheet change
// that still give an element's property its head value, found by delta
// debugging in one loaded page: the library stylesheet is swapped for each
// candidate in place, and the property read again.
import {
  cssUnits,
  ddmin,
  diffUnits,
  type Step,
  serializeUnit,
} from "../core/reduce";
import { STATE_SETS } from "../page/states";
import { serveFixtures, swappedSheet } from "./serve";
import { preparePage, tagStates } from "./snapshot";
import { type EngineName, loadPage, View } from "./view";

export interface ReduceOptions {
  /** The fixture directory, and the library stylesheet's marker. */
  dir: string;
  sheetMarker: string;
  base: string;
  head: string;
  /** The page: fixture name and theme (and its viewport). */
  fixture: string;
  theme: string;
  themeAttribute?: string | null;
  viewport?: { width: number; height: number };
  /** The element, as a snapshot path (with its state and pseudo-element). */
  path: string;
  property: string;
  engine: EngineName;
  chromePath?: string;
  emulate: "cdp" | "cssom";
  readySelector?: string;
  readyTimeoutMs?: number;
  settleMs?: number;
}

export interface Reduced {
  /** The property's value under base, and under head. */
  before: string;
  after: string;
  /** Edits between the stylesheets, and the fewest that give `after`. */
  total: number;
  edits: Step[];
  /** Candidates tried. */
  tests: number;
  ms: number;
}

const PSEUDO_RE = /::(before|after)$/;

export async function reduceChange(opts: ReduceOptions): Promise<Reduced> {
  const started = performance.now();
  const base = cssUnits(opts.base);
  const script = diffUnits(base.units, cssUnits(opts.head).units);
  const edits = script.filter((s) => s.op !== "=");
  const server = serveFixtures(opts.dir, {
    swap: { marker: opts.sheetMarker, css: opts.base },
  });
  const view = new View({
    engine: opts.engine,
    chromePath: opts.chromePath,
    ...opts.viewport,
  });
  try {
    if (opts.viewport) await view.resize(opts.viewport);
    const attr =
      opts.themeAttribute === undefined ? "theme" : opts.themeAttribute;
    await loadPage(
      view,
      `${server.url}/${opts.fixture}.html${attr === null ? "" : `?cr-attr=${encodeURIComponent(attr)}&cr-value=${encodeURIComponent(opts.theme)}`}`,
      opts,
    );
    await preparePage(view, {
      states: "cdp",
      emulate: opts.emulate,
      settleMs: opts.settleMs,
    });
    await tagStates(view);
    // The library stylesheet becomes a <style> in its place, and each
    // candidate is the units it keeps: base, edited.
    const sheet = swappedSheet(opts.dir, opts.sheetMarker)
      .split("\\")
      .join("/");
    const swapped = await view.evaluate<boolean>(`((sheet, prelude, units) => {
      const link = Array.from(document.querySelectorAll("link[rel~=stylesheet]"))
        .find((l) => new URL(l.href).pathname === "/" + sheet);
      if (!link) return false;
      const style = document.createElement("style");
      style.id = "cr-reduce";
      link.replaceWith(style);
      window.__crReduce = { style, prelude, units };
      return true;
    })(${JSON.stringify(sheet)}, ${JSON.stringify(base.prelude)}, ${JSON.stringify(script.map((s) => [s.op, serializeUnit(s.unit)]))})`);
    if (!swapped)
      throw new Error(`${opts.fixture} doesn't load ${sheet} with a <link>`);
    const target = await view.evaluate<{ state: string | null } | null>(
      `window.__cr.target(${JSON.stringify(opts.path)})`,
    );
    if (!target) throw new Error(`no element at ${opts.path}`);
    if (target.state) {
      await view.cdp("DOM.enable");
      await view.cdp("CSS.enable");
      const { root } = await view.cdp<{ root: { nodeId: number } }>(
        "DOM.getDocument",
        { depth: 0 },
      );
      const { nodeId } = await view.cdp<{ nodeId: number }>(
        "DOM.querySelector",
        { nodeId: root.nodeId, selector: "[data-cr-forced]" },
      );
      await view.cdp("CSS.forcePseudoState", {
        nodeId,
        forcedPseudoClasses: STATE_SETS[target.state],
      });
    }
    const pseudo = PSEUDO_RE.exec(opts.path)?.[0] ?? null;
    let tests = 0;
    const read = (chosen: number[]) => {
      tests++;
      return view.evaluate<string>(`((chosen, property, pseudo) => {
        const { style, prelude, units } = window.__crReduce;
        const on = new Set(chosen);
        const out = [prelude];
        let i = 0;
        for (const [op, text] of units) {
          if (op === "=") out.push(text);
          else if ((op === "-") !== on.has(i++)) out.push(text);
        }
        style.textContent = out.join("\\n");
        return getComputedStyle(document.querySelector("[data-cr-target]"), pseudo).getPropertyValue(property);
      })(${JSON.stringify(chosen)}, ${JSON.stringify(opts.property)}, ${JSON.stringify(pseudo)})`);
    };
    const all = edits.map((_, i) => i);
    const before = await read([]);
    const after = await read(all);
    if (before === after)
      throw new Error(
        `${opts.property} is ${before} on both sides here: nothing to reduce`,
      );
    const kept = await ddmin(
      all,
      async (subset) => (await read(subset)) === after,
    );
    return {
      before,
      after,
      total: edits.length,
      edits: kept.map((i) => edits[i]),
      tests,
      ms: performance.now() - started,
    };
  } finally {
    view.close();
    server.stop();
  }
}
