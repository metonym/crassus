/**
 * Selector matching cost during a full-document recalc: a Bun.WebView port of
 * carbon-components-svelte's e2e/selector-stats.ts, run by ./selector-stats.ts
 * from the checkout. A measurement spike, not headed for src/.
 *
 * Toggles an inherited custom property no rule reads (or, with `--trigger
 * theme`, the Carbon theme), so every element re-resolves style while
 * computed values stay put. Traced `SelectorStats` read the clock per match
 * attempt and inflate recalc ~10x: rank with them, don't size a saving; the
 * untraced `RecalcStyleDuration` variants do that.
 *
 *   bun …/selector-stats-harness.ts <scenario|all> [--runs 15] [--recalc-runs 40]
 *     [--inner 5] [--top 25] [--scale N] [--trigger var|theme] [--json out.json]
 *     [--url <base>]
 */
import { readdir, writeFile } from "node:fs/promises";
import { View } from "../../src/browser/view";
import { splitList } from "../../src/core/selector";

const PORT = 4177;
const [scenarioKey, ...rest] = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const RUNS = Number(opt("runs") ?? 15);
const RECALC_RUNS = Number(opt("recalc-runs") ?? 40);
const INNER = Number(opt("inner") ?? 5);
const TOP = Number(opt("top") ?? 25);
const SCALE = opt("scale");
const JSON_OUT = opt("json");
const URL = opt("url");
const TRIGGER = opt("trigger") ?? "var";

const scenarios: Record<string, { fixture: string; scale: number }> = {
  "data-table": { fixture: "data-table", scale: 12 },
  "data-table-overflow": { fixture: "data-table-overflow-menu", scale: 10 },
  "tree-view": { fixture: "tree-view-virtualize", scale: 40 },
  // `.bx--link__icon svg`, `path`
  "link-icons": { fixture: "link", scale: 200 },
  // `.bx--btn__icon path:not(...)`
  "button-icons": { fixture: "menu-button", scale: 300 },
};

interface Timing {
  elapsed: number;
  attempts: number;
  matches: number;
  fastRejects: number;
}

interface TraceEvent {
  name: string;
  ph: string;
  dur?: number;
  args?: {
    elementCount?: number;
    selector_stats?: {
      selector_timings?: {
        "elapsed (us)": number;
        match_attempts: number;
        match_count: number;
        fast_reject_count: number;
        selector: string;
        style_sheet_id: string;
      }[];
    };
  };
}

interface SelectorRow extends Timing {
  selector: string;
  sheet: string;
  share: number;
  typeTail: boolean;
}

interface Stats {
  median: number;
  iqr: number;
  min: number;
  max: number;
}

interface Report {
  scenario: string;
  fixture: string;
  scale: number;
  elements: number;
  recalc: {
    variant: string;
    removedSelectors: number;
    ms: Stats;
    /** Paired difference from baseline in the same run. */
    diffMs: Stats;
  }[];
  traced: {
    runs: number;
    updateLayoutTreeMs: Stats;
    elementCount: Stats;
    selectorTotalMs: Stats;
    attempts: Stats;
    typeTailShare: Stats;
    universalShare: Stats;
    typeTailAttemptShare: Stats;
    floorNsPerAttempt: number;
  };
  top: SelectorRow[];
  topTypeTail: SelectorRow[];
}

async function startServer(
  port: number,
  url?: string,
): Promise<{ base: string; server?: ReturnType<typeof Bun.spawn> }> {
  const base = url ?? `http://localhost:${port}`;
  if (url) return { base };
  const server = Bun.spawn(
    [
      "bunx",
      "vite",
      "--config",
      "e2e/vite.config.ts",
      "--port",
      String(port),
      "--strictPort",
    ],
    { stdout: "ignore", stderr: "inherit" },
  );
  for (let i = 0; i < 100; i++) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: polling until the server answers
      if ((await fetch(base)).status) return { base, server };
    } catch {}
    await Bun.sleep(200);
  }
  throw new Error(`server at ${base} did not start`);
}

/** Runs `fn(arg)` in the page; `fn` must be self-contained. */
const inPage = <A, T>(view: View, fn: (arg: A) => T, arg?: A) =>
  view.evaluate<T>(`(${fn})(${arg === undefined ? "" : JSON.stringify(arg)})`);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function iqr(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.floor(p * (s.length - 1))];
  return q(0.75) - q(0.25);
}

const stats = (xs: number[]): Stats => ({
  median: median(xs),
  iqr: iqr(xs),
  min: Math.min(...xs),
  max: Math.max(...xs),
});

const COMBINATOR = /[\s>+~]/;
/** Id, class or attribute: what Blink buckets a rule by before its tag. */
const BUCKETABLE = /[.#[]/;
const TYPE_SELECTOR = /^[a-z]/i;

/** `.a > b:not(.c):hover` -> `b:not:hover`, and where it starts. */
function splitRightmost(selector: string): {
  start: number;
  compound: string;
} {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (depth === 0 && COMBINATOR.test(ch)) start = i + 1;
  }
  let compound = selector.slice(start);
  let prev: string;
  do {
    prev = compound;
    compound = compound.replace(/\([^()]*\)/g, "");
  } while (compound !== prev);
  return { start, compound };
}

const rightmostCompound = (selector: string) =>
  splitRightmost(selector).compound;

const hasCombinator = (selector: string) => splitRightmost(selector).start > 0;

const isTypeTail = (selector: string) =>
  !BUCKETABLE.test(rightmostCompound(selector));

function isUniversalTail(selector: string): boolean {
  const c = rightmostCompound(selector);
  return !BUCKETABLE.test(c) && !TYPE_SELECTOR.test(c);
}

function sheetLabel(id: string, libSheets: Set<string>): string {
  if (id === "ua-style-sheet") return "ua";
  return libSheets.has(id) ? "lib" : "other";
}

const toggle = (view: View, on: boolean) =>
  inPage(
    view,
    ({ on, trigger }) => {
      const root = document.documentElement;
      if (trigger === "theme")
        root.setAttribute("theme", on ? "g100" : "white");
      else root.style.setProperty("--ccs-selector-stats", on ? "1" : "0");
      void document.body.offsetHeight;
    },
    { on, trigger: TRIGGER },
  );

async function trace(
  view: View,
  fn: () => Promise<unknown>,
): Promise<TraceEvent[]> {
  const events: TraceEvent[] = [];
  const offData = view.on<{ value: TraceEvent[] }>(
    "Tracing.dataCollected",
    (e) => {
      events.push(...e.value);
    },
  );
  const complete = new Promise<void>((resolve) => {
    const off = view.on("Tracing.tracingComplete", () => {
      off();
      resolve();
    });
  });
  await view.cdp("Tracing.start", {
    traceConfig: {
      includedCategories: [
        "disabled-by-default-blink.debug",
        "devtools.timeline",
      ],
    },
    transferMode: "ReportEvents",
  });
  await fn();
  await view.cdp("Tracing.end");
  await complete;
  offData();
  return events;
}

async function loadScenario(
  view: View,
  base: string,
  fixture: string,
  scale: number,
): Promise<number> {
  await view.navigate(`${base}/${fixture}.html`);
  await Bun.sleep(300);
  return inPage(
    view,
    (n) => {
      const app = document.getElementById("app");
      if (!app) throw new Error("#app not found");
      // A wrapper per copy: thousands of siblings would make `~` / `+`
      // selectors walk more than any real page.
      const originals = Array.from(app.children);
      for (let i = 0; i < n - 1; i++) {
        const copy = document.createElement("div");
        for (const el of originals) copy.appendChild(el.cloneNode(true));
        app.appendChild(copy);
      }
      document.documentElement.setAttribute("theme", "white");
      void document.body.offsetHeight;
      return document.getElementsByTagName("*").length;
    },
    scale,
  );
}

/**
 * Stores the library sheet minus `drop`ped selectors in the page. Baseline
 * takes the same CSSOM round-trip, so every variant is parsed the same way.
 */
async function buildVariant(
  view: View,
  name: string,
  drop: (selector: string) => boolean,
): Promise<number> {
  const rules = await inPage(view, () => {
    const w = window as unknown as { __ccsSource: string };
    if (!w.__ccsSource) {
      const style = Array.from(document.querySelectorAll("style")).sort(
        (a, b) => b.textContent.length - a.textContent.length,
      )[0];
      style.setAttribute("data-ccs-lib", "");
      w.__ccsSource = style.textContent;
    }
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(w.__ccsSource);
    const out: { path: number[]; selectorText: string }[] = [];
    const visit = (list: CSSRuleList, path: number[]) => {
      Array.from(list).forEach((rule, i) => {
        if (rule instanceof CSSStyleRule) {
          out.push({ path: [...path, i], selectorText: rule.selectorText });
        } else if ("cssRules" in rule) {
          visit((rule as CSSGroupingRule).cssRules, [...path, i]);
        }
      });
    };
    visit(sheet.cssRules, []);
    return out;
  });

  let removed = 0;
  const edits: { path: number[]; selectorText: string | null }[] = [];
  for (const { path, selectorText } of rules) {
    const parts = splitList(selectorText).map((s) => s.text);
    const keep = parts.filter((p) => !drop(p));
    if (keep.length === parts.length) continue;
    removed += parts.length - keep.length;
    edits.push({ path, selectorText: keep.length ? keep.join(", ") : null });
  }

  await inPage(
    view,
    ({ name, edits }) => {
      const w = window as unknown as {
        __ccsSource: string;
        __ccsVariants?: Record<string, string>;
      };
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(w.__ccsSource);
      // Last rule first, so deletions don't shift indices still pending.
      for (const { path, selectorText } of edits.reverse()) {
        let parent: CSSStyleSheet | CSSGroupingRule = sheet;
        for (const i of path.slice(0, -1)) {
          parent = parent.cssRules[i] as CSSGroupingRule;
        }
        const index = path[path.length - 1];
        if (selectorText === null) parent.deleteRule(index);
        else {
          (parent.cssRules[index] as CSSStyleRule).selectorText = selectorText;
        }
      }
      w.__ccsVariants ??= {};
      w.__ccsVariants[name] = Array.from(sheet.cssRules)
        .map((r) => r.cssText)
        .join("\n");
    },
    { name, edits },
  );
  return removed;
}

const useVariant = (view: View, name: string) =>
  inPage(
    view,
    (n) => {
      const w = window as unknown as { __ccsVariants: Record<string, string> };
      const style = document.querySelector("style[data-ccs-lib]");
      if (!style) throw new Error("library <style> not found");
      style.textContent = w.__ccsVariants[n];
      void document.body.offsetHeight;
    },
    name,
  );

/** Variants interleave within each run, so load drift hits all alike. */
async function measureRecalc(
  view: View,
  names: string[],
): Promise<Record<string, { ms: number[]; diff: number[] }>> {
  const read = async () => {
    const { metrics } = await view.cdp<{
      metrics: { name: string; value: number }[];
    }>("Performance.getMetrics");
    return metrics.find((m) => m.name === "RecalcStyleDuration")?.value ?? 0;
  };
  // Min of a few toggles: other processes can only add time.
  async function recalcMs(): Promise<number> {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < INNER; i++) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential by design
      const before = await read();
      await toggle(view, true);
      const after = await read();
      await toggle(view, false);
      best = Math.min(best, (after - before) * 1000);
    }
    return best;
  }

  const out: Record<string, { ms: number[]; diff: number[] }> = {};
  for (const n of names) out[n] = { ms: [], diff: [] };

  for (let run = 0; run < RECALC_RUNS; run++) {
    const sample: Record<string, number> = {};
    for (let j = 0; j < names.length; j++) {
      const name = names[(run + j) % names.length];
      // biome-ignore lint/performance/noAwaitInLoops: sequential by design
      await useVariant(view, name);
      // Warmup: let selector/style caches settle on the new sheet.
      for (let i = 0; i < 3; i++) {
        // biome-ignore lint/performance/noAwaitInLoops: sequential by design
        await toggle(view, true);
        await toggle(view, false);
      }
      sample[name] = await recalcMs();
    }
    for (const n of names) {
      out[n].ms.push(sample[n]);
      out[n].diff.push(sample[n] - sample[names[0]]);
    }
  }
  return out;
}

async function runScenario(key: string, base: string): Promise<Report> {
  const scenario = scenarios[key];
  const scale = SCALE ? Number(SCALE) : scenario.scale;

  const view = new View({
    engine: "chrome",
    chromePath: process.env.CR_CHROME_PATH,
    width: 1280,
    height: 900,
  });
  await view.cdp("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  const elements = await loadScenario(view, base, scenario.fixture, scale);
  await view.cdp("Performance.enable");

  // The library sheet is the one large sheet vite injects for the fixture's
  // `carbon-components-svelte/css/all.css` import.
  await view.cdp("DOM.enable");
  const libSheets = new Set<string>();
  view.on<{ header: { length: number; styleSheetId: string } }>(
    "CSS.styleSheetAdded",
    ({ header }) => {
      if (header.length > 100_000) libSheets.add(header.styleSheetId);
    },
  );
  await view.cdp("CSS.enable");
  await toggle(view, true);
  await toggle(view, false);

  const perSelector = new Map<string, Timing[]>();
  const ultMs: number[] = [];
  const ultElements: number[] = [];
  const selectorTotalMs: number[] = [];
  const totalAttempts: number[] = [];
  const typeTailShare: number[] = [];
  const universalShare: number[] = [];
  const typeTailAttemptShare: number[] = [];

  for (let run = 0; run < RUNS; run++) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential by design
    const events = await trace(view, () => toggle(view, true));
    await toggle(view, false);

    let ult = 0;
    let ultCount = 0;
    for (const e of events) {
      if (e.name === "UpdateLayoutTree" && e.ph === "X") {
        ult += e.dur ?? 0;
        ultCount += e.args?.elementCount ?? 0;
      }
    }
    ultMs.push(ult / 1000);
    ultElements.push(ultCount);

    const runTimings = new Map<string, Timing>();
    for (const e of events) {
      if (e.name !== "SelectorStats") continue;
      for (const t of e.args?.selector_stats?.selector_timings ?? []) {
        const id = `${sheetLabel(t.style_sheet_id, libSheets)}\u0000${t.selector}`;
        const acc = runTimings.get(id) ?? {
          elapsed: 0,
          attempts: 0,
          matches: 0,
          fastRejects: 0,
        };
        acc.elapsed += t["elapsed (us)"];
        acc.attempts += t.match_attempts;
        acc.matches += t.match_count;
        acc.fastRejects += t.fast_reject_count;
        runTimings.set(id, acc);
      }
    }
    if (runTimings.size === 0) {
      throw new Error(
        "no SelectorStats trace events; this Chromium may not emit them",
      );
    }

    let total = 0;
    let attempts = 0;
    let typeTail = 0;
    let typeTailAttempts = 0;
    let universal = 0;
    for (const [id, t] of runTimings) {
      const selector = id.slice(id.indexOf("\u0000") + 1);
      total += t.elapsed;
      attempts += t.attempts;
      if (isTypeTail(selector)) {
        typeTail += t.elapsed;
        typeTailAttempts += t.attempts;
      }
      if (isUniversalTail(selector)) universal += t.elapsed;
      const list = perSelector.get(id) ?? [];
      list.push(t);
      perSelector.set(id, list);
    }
    selectorTotalMs.push(total / 1000);
    totalAttempts.push(attempts);
    typeTailShare.push(total ? typeTail / total : 0);
    universalShare.push(total ? universal / total : 0);
    typeTailAttemptShare.push(attempts ? typeTailAttempts / attempts : 0);
  }

  const totalMedianUs = median(selectorTotalMs) * 1000;
  // Selectors absent from a run contributed 0 to it.
  const pad = (xs: number[]) => [...xs, ...Array(RUNS - xs.length).fill(0)];
  const rows: SelectorRow[] = [];
  for (const [id, list] of perSelector) {
    const [sheet, selector] = id.split("\u0000");
    const elapsed = median(pad(list.map((t) => t.elapsed)));
    rows.push({
      selector,
      sheet,
      elapsed,
      attempts: median(pad(list.map((t) => t.attempts))),
      matches: median(pad(list.map((t) => t.matches))),
      fastRejects: median(pad(list.map((t) => t.fastRejects))),
      share: totalMedianUs ? elapsed / totalMedianUs : 0,
      typeTail: isTypeTail(selector),
    });
  }
  rows.sort((a, b) => b.elapsed - a.elapsed || b.attempts - a.attempts);
  // Cheapest per-attempt cost among often-attempted selectors: roughly the
  // tracing clock overhead, since a bloom-filter reject is a few ns.
  const floorNs = Math.min(
    ...rows
      .filter((r) => r.attempts >= 1000)
      .map((r) => (r.elapsed * 1000) / r.attempts),
  );

  // Variants delete only selectors that never matched, so computed style is
  // unchanged and any delta is matching cost. The control deletes as many
  // class tails absent from the page (never attempted; expect ~0).
  const unmatched = new Set(
    [...perSelector]
      .filter(
        ([id, list]) =>
          id.startsWith("lib\u0000") && list.every((t) => t.matches === 0),
      )
      .map(([id]) => id.slice(id.indexOf("\u0000") + 1)),
  );
  const isQualifiedTypeTail = (sel: string) =>
    isTypeTail(sel) && hasCombinator(sel);
  const pageClasses = new Set(
    await inPage(view, () =>
      Array.from(document.querySelectorAll("[class]")).flatMap((el) =>
        Array.from(el.classList),
      ),
    ),
  );
  let controlLeft = [...unmatched].filter(isQualifiedTypeTail).length;
  const isAbsentClassTail = (sel: string) => {
    if (controlLeft <= 0 || !hasCombinator(sel)) return false;
    const classes = [...rightmostCompound(sel).matchAll(/\.([\w-]+)/g)];
    if (!classes.length || classes.some(([, c]) => pageClasses.has(c))) {
      return false;
    }
    controlLeft--;
    return true;
  };

  const variants = [
    { name: "baseline", drop: () => false },
    {
      name: "-unmatched type/* tails",
      drop: (sel: string) => unmatched.has(sel) && isQualifiedTypeTail(sel),
    },
    { name: "-control class tails", drop: isAbsentClassTail },
  ];
  const removed: Record<string, number> = {};
  for (const v of variants) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential by design
    removed[v.name] = await buildVariant(view, v.name, v.drop);
  }
  const samples = await measureRecalc(
    view,
    variants.map((v) => v.name),
  );
  view.close();

  return {
    scenario: key,
    fixture: scenario.fixture,
    scale,
    elements,
    recalc: variants.map((v) => ({
      variant: v.name,
      removedSelectors: removed[v.name],
      ms: stats(samples[v.name].ms),
      diffMs: stats(samples[v.name].diff),
    })),
    traced: {
      runs: RUNS,
      updateLayoutTreeMs: stats(ultMs),
      elementCount: stats(ultElements),
      selectorTotalMs: stats(selectorTotalMs),
      attempts: stats(totalAttempts),
      typeTailShare: stats(typeTailShare),
      universalShare: stats(universalShare),
      typeTailAttemptShare: stats(typeTailAttemptShare),
      floorNsPerAttempt: floorNs,
    },
    top: rows.slice(0, TOP),
    topTypeTail: rows.filter((r) => r.typeTail).slice(0, TOP),
  };
}

const fmt = (s: Stats, digits = 3) =>
  `median=${s.median.toFixed(digits)}  iqr=${s.iqr.toFixed(digits)}  min=${s.min.toFixed(digits)}  max=${s.max.toFixed(digits)}`;

function printTable(title: string, rows: SelectorRow[]): void {
  console.log(`\n  ${title}`);
  console.log(
    "    elapsed(us)  share   attempts  matches  fastrej  sheet  selector",
  );
  for (const r of rows) {
    console.log(
      `    ${String(r.elapsed).padStart(11)}  ${(r.share * 100).toFixed(1).padStart(5)}%  ${String(r.attempts).padStart(8)}  ${String(r.matches).padStart(7)}  ${String(r.fastRejects).padStart(7)}  ${r.sheet.padEnd(5)}  ${r.selector}`,
    );
  }
}

function print(r: Report): void {
  console.log(
    `\nscenario=${r.scenario} fixture=${r.fixture} scale=${r.scale} elements=${r.elements} trigger=${TRIGGER}`,
  );
  const base = r.recalc[0].ms.median;
  console.log(
    `  untraced RecalcStyleDuration ms (${RECALC_RUNS} runs, min of ${INNER}):`,
  );
  for (const v of r.recalc) {
    console.log(
      `    ${v.variant.padEnd(24)} removed=${String(v.removedSelectors).padStart(4)}  ${fmt(v.ms)}`,
    );
    if (v !== r.recalc[0]) {
      const delta = (v.diffMs.median / base) * 100;
      console.log(
        `    ${"".padEnd(24)} paired diff: ${fmt(v.diffMs)}  (${delta.toFixed(1)}% of baseline)`,
      );
    }
  }
  const t = r.traced;
  console.log(`  traced (${t.runs} runs):`);
  console.log(`    UpdateLayoutTree ms:       ${fmt(t.updateLayoutTreeMs)}`);
  console.log(`    elements recalculated:     ${fmt(t.elementCount, 0)}`);
  console.log(`    sum of selector ms:        ${fmt(t.selectorTotalMs)}`);
  console.log(`    match attempts:            ${fmt(t.attempts, 0)}`);
  console.log(`    type/* tail share of ms:   ${fmt(t.typeTailShare)}`);
  console.log(`    * tail share of ms:        ${fmt(t.universalShare)}`);
  console.log(`    type/* tail attempt share: ${fmt(t.typeTailAttemptShare)}`);
  console.log(
    `    floor ns/attempt:          ${t.floorNsPerAttempt.toFixed(1)} (tracing overhead; elapsed below includes it per attempt)`,
  );
  printTable(`top ${TOP} selectors by median elapsed`, r.top);
  printTable(`top ${TOP} type/* tail selectors`, r.topTypeTail);
}

const keys = scenarioKey === "all" ? Object.keys(scenarios) : [scenarioKey];
if (!keys.every((k) => k in scenarios)) {
  console.error(
    `usage: selector-stats.ts <${Object.keys(scenarios).join("|")}|all> [--runs N] [--recalc-runs N] [--inner N] [--top N] [--scale N] [--trigger var|theme] [--json out.json]`,
  );
  process.exit(2);
}

// Fixtures come from the checkout's e2e/fixtures, served by its e2e Vite
// config: the variant builder edits the <style> tag the dev server injects.
const fixtures = await readdir("e2e/fixtures");
for (const k of keys) {
  if (!fixtures.includes(`${scenarios[k].fixture}.html`)) {
    throw new Error(`fixture not found: ${scenarios[k].fixture}`);
  }
}

const { base, server } = await startServer(PORT, URL);
const reports: Report[] = [];
try {
  console.log("chromium Bun.WebView");
  for (const key of keys) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential by design
    const report = await runScenario(key, base);
    print(report);
    reports.push(report);
  }
  if (JSON_OUT) {
    await writeFile(JSON_OUT, JSON.stringify(reports, null, 2));
    console.log(`\nwrote ${JSON_OUT}`);
  }
} finally {
  Bun.WebView.closeAll();
  server?.kill();
}
