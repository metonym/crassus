// Real-browser smoke test for crassus/browser: one fixture page through
// both snapshot state modes and both usage engines, on Chrome (auto-detected
// by Bun.WebView; GitHub's ubuntu runners ship it).
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRules } from "crassus";
import {
  capture,
  diffSnapshots,
  runUsage,
  serveFixtures,
} from "crassus/browser";
import { View } from "../src/browser/view";
import {
  parseSelectorList,
  resolveNested,
  serializeList,
} from "../src/core/selector";
import type { DeclarationStats } from "../src/core/usage";
import { generator } from "./fuzz-gen";

const LIB_CSS = `
.bx--btn { color: red; padding: var(--p, 1px) 2px; margin-block: var(--m, 1px) 0; }
.bx--wrap .bx--btn { color: blue; }
.bx--btn:hover { color: green; }
button { padding: 0; margin-block-start: 0; }
@media (width >= 1px) { .bx--wrap { margin: 0; } }
@media (width>=1px)and (min-height:1px) { .bx--wrap { padding: 0; } }
.bx--unused { top: 0; }
`;
const PAGE = `<!doctype html><html><head><link rel="stylesheet" href="lib.css"></head>
<body><div class="bx--wrap"><button class="bx--btn">Go</button></div></body></html>`;

// Layer order outranks specificity, and reverses for !important.
const LAYERS_CSS = `
@layer bx--base, bx--comp;
.bx--x { color: red; }
@layer bx--comp { .bx--x { color: blue; top: 1px !important; } }
@layer bx--base { #a.bx--x { color: green; top: 2px !important; } }
@scope (.bx--r) { .bx--x { left: 1px; } }
.bx--x { left: 2px; }
`;
const LAYERS_PAGE = `<!doctype html><html><head><link rel="stylesheet" href="layers.css"></head>
<body><div class="bx--r"><p id="a" class="bx--x">x</p></div></body></html>`;

const IMPORTANT_RE = /\s*!important$/;
const BOM_RE = /^\uFEFF/;

// Nested rules resolve `&` against their parent; declarations after a nested
// rule, or in a nested @media, are rules of their own at that position.
const NESTING_CSS = `
.bx--p, #b {
  color: red;
  .bx--x { color: blue; top: 1px; }
  @media (width >= 1px) { left: 1px; > .bx--x { left: 2px; } }
  color: green;
}
.bx--p .bx--x { top: 2px; }
`;
const NESTING_PAGE = `<!doctype html><html><head><link rel="stylesheet" href="nesting.css"></head>
<body><div class="bx--p"><p class="bx--x">x</p></div></body></html>`;

// Below and above 42rem (672px).
const VIEWPORT_CSS = `
.bx--v { color: blue; height: 100vh; }
@media (min-width: 42rem) { .bx--v { color: red; } }
@media (max-width: 41.98rem) { .bx--v { top: 1px; } }
`;
const VIEWPORT_PAGE = `<!doctype html><html><head><link rel="stylesheet" href="viewport.css"></head>
<body><p class="bx--v">x</p></body></html>`;

// Content that arrives after load.
const LATE_PAGE = `<!doctype html><html><head><style>.bx--late { color: red; }</style></head>
<body><script>setTimeout(() => { const p = document.createElement("p"); p.className = "bx--late"; document.body.append(p); }, 200);</script></body></html>`;

const DIFF_PAGE = `<!doctype html><html><head><link rel="stylesheet" href="diff.css"></head>
<body><div class="bx--d"><p class="bx--d">a</p><p class="bx--d">b</p></div><span class="bx--e">c</span></body></html>`;
const diffCss = (color: string) =>
  `.bx--d { color: ${color}; margin: 0; } .bx--e { color: green; }`;

let dir = "";
let server: ReturnType<typeof serveFixtures>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "crassus-browser-"));
  await Bun.write(join(dir, "site/lib.css"), LIB_CSS);
  await Bun.write(join(dir, "site/page.html"), PAGE);
  await Bun.write(join(dir, "site/layers.css"), LAYERS_CSS);
  await Bun.write(join(dir, "site/layers.html"), LAYERS_PAGE);
  await Bun.write(join(dir, "site/nesting.css"), NESTING_CSS);
  await Bun.write(join(dir, "site/nesting.html"), NESTING_PAGE);
  await Bun.write(join(dir, "site/viewport.css"), VIEWPORT_CSS);
  await Bun.write(join(dir, "site/viewport.html"), VIEWPORT_PAGE);
  await Bun.write(join(dir, "site/late.html"), LATE_PAGE);
  server = serveFixtures(join(dir, "site"));
});

afterAll(async () => {
  server.stop();
  Bun.WebView.closeAll();
  await rm(dir, { recursive: true, force: true });
});

const base = () => ({
  baseUrl: server.url,
  fixtures: ["page"],
  themes: ["white"],
  engine: "chrome" as const,
  concurrency: 1,
  sheetMarker: ".bx--",
});

it("captures the same forced states via CDP and via selector rewrite", async () => {
  for (const states of ["cdp", "rewrite"] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: one browser, sequential captures
    await capture({
      ...base(),
      outDir: join(dir, states),
      states,
      emulate: "cdp",
      settleMs: 50,
    });
  }
  const [file] = await readdir(join(dir, "cdp"));
  const cdp = await Bun.file(join(dir, "cdp", file)).json();
  const rewrite = await Bun.file(join(dir, "rewrite", file)).json();
  expect(rewrite).toEqual(cdp);
  const hovered = Object.entries(cdp).find(([key]) =>
    key.endsWith("button.bx--btn@hover"),
  );
  expect(hovered).toBeDefined();
  expect((hovered?.[1] as Record<string, string> | undefined)?.color).toBe(
    "rgb(0, 128, 0)",
  );
}, 60_000);

it("diffSnapshots groups a seeded color change once and lists one-sided pages", async () => {
  // Two sites, so the second capture can't reuse a cached stylesheet.
  const sides = [
    ["base", "blue", ["diff"]],
    ["head", "purple", ["diff", "extra"]],
  ] as const;
  await Promise.all(
    sides.flatMap(([side, color]) => [
      Bun.write(join(dir, side, "diff.css"), diffCss(color)),
      Bun.write(join(dir, side, "diff.html"), DIFF_PAGE),
      Bun.write(join(dir, side, "extra.html"), DIFF_PAGE),
    ]),
  );
  for (const [side, , fixtures] of sides) {
    const site = serveFixtures(join(dir, side));
    try {
      // biome-ignore lint/performance/noAwaitInLoops: one browser, sequential captures
      await capture({
        ...base(),
        baseUrl: site.url,
        fixtures: [...fixtures],
        outDir: join(dir, `snap-${side}`),
        states: false,
        emulate: "cdp",
        settleMs: 0,
      });
    } finally {
      site.stop();
    }
  }
  const diff = await diffSnapshots(
    join(dir, "snap-base"),
    join(dir, "snap-head"),
  );
  expect(diff.onlyBase).toEqual([]);
  expect(diff.onlyHead).toEqual(["extra.white.json"]);
  expect(diff.files).toBe(1);
  expect(diff.groups).toEqual([
    {
      property: "color",
      before: "rgb(0, 0, 255)",
      after: "rgb(128, 0, 128)",
      count: 3,
      pages: ["diff.white.json"],
      examples: [
        { page: "diff.white.json", path: "body>div.bx--d" },
        { page: "diff.white.json", path: "body>div.bx--d>p.bx--d" },
        { page: "diff.white.json", path: "body>div.bx--d>p.bx--d[1]" },
      ],
    },
  ]);
  expect(diff.pages).toMatchObject([
    {
      file: "diff.white.json",
      fixture: "diff",
      theme: "white",
      removed: [],
      added: [],
    },
  ]);
  expect(Object.keys(diff.pages[0].changed)).toHaveLength(3);
}, 60_000);

it("captures each viewport into its own file, and usage aggregates them", async () => {
  const viewports = [
    { width: 320, height: 640 },
    { width: 1280, height: 900 },
  ];
  const outDir = join(dir, "snap-viewports");
  await capture({
    ...base(),
    fixtures: ["viewport"],
    outDir,
    viewports,
    // Two fresh tabs: the second resizes before it has loaded anything.
    concurrency: 2,
    states: false,
    emulate: "cdp",
    settleMs: 0,
  });
  expect((await readdir(outDir)).sort()).toEqual([
    "viewport.white.1280x900.json",
    "viewport.white.320x640.json",
  ]);
  const color = async (file: string) =>
    (await Bun.file(join(outDir, file)).json())["body>p.bx--v"].color;
  expect(await color("viewport.white.320x640.json")).toBe("rgb(0, 0, 255)");
  expect(await color("viewport.white.1280x900.json")).toBe("rgb(255, 0, 0)");
  // The page gets the whole viewport: Chrome's window size includes its UI.
  const height = async (dir: string, file: string) =>
    (await Bun.file(join(dir, file)).json())["body>p.bx--v"].height;
  expect(await height(outDir, "viewport.white.320x640.json")).toBe("640px");
  expect(await height(outDir, "viewport.white.1280x900.json")).toBe("900px");
  await capture({
    ...base(),
    fixtures: ["viewport"],
    outDir: join(dir, "snap-default-viewport"),
    states: false,
    emulate: "cdp",
    settleMs: 0,
  });
  expect(
    await height(join(dir, "snap-default-viewport"), "viewport.white.json"),
  ).toBe("900px");

  const unmatched = async (vs?: typeof viewports) => {
    const out = join(dir, `usage-viewports-${vs?.length ?? 0}`);
    const { notReady } = await runUsage({
      ...base(),
      fixtures: ["viewport"],
      outDir: out,
      matcher: "cdp",
      emulate: "cdp",
      states: false,
      viewports: vs,
    });
    expect(notReady).toEqual([]);
    const report = await Bun.file(join(out, "usage.json")).json();
    return report.unmatched.map((r: { context: string }) => r.context);
  };
  // One viewport (1280): the max-width rule never matches.
  expect(await unmatched()).toEqual(["@media (max-width:41.98rem)"]);
  expect(await unmatched(viewports)).toEqual([]);
}, 60_000);

it("waits for readySelector, and lists pages that never get there", async () => {
  const opts = {
    ...base(),
    fixtures: ["late"],
    states: false as const,
    emulate: "cdp" as const,
    settleMs: 0,
  };
  const outDir = join(dir, "snap-late");
  const ready = await capture({ ...opts, outDir, readySelector: ".bx--late" });
  expect(ready.notReady).toEqual([]);
  const snap = await Bun.file(join(outDir, "late.white.json")).json();
  expect(snap["body>p.bx--late"]?.color).toBe("rgb(255, 0, 0)");

  const never = await capture({
    ...opts,
    outDir: join(dir, "snap-never"),
    readySelector: ".bx--never",
    readyTimeoutMs: 300,
  });
  expect(never.notReady).toEqual(["late white"]);
  const usage = await runUsage({
    ...opts,
    outDir: join(dir, "usage-never"),
    matcher: "dom",
    states: false,
    readySelector: ".bx--never",
    readyTimeoutMs: 300,
  });
  expect(usage.notReady).toEqual(["late white"]);
}, 60_000);

const usageStats = async (matcher: "cdp" | "dom", page = "page") => {
  const outDir = join(dir, `usage-${page}-${matcher}`);
  await runUsage({
    ...base(),
    fixtures: [page],
    outDir,
    matcher,
    emulate: "cdp",
    states: true,
    settleMs: 50,
  });
  const { declarations } = await Bun.file(join(outDir, "usage.json")).json();
  // CDP's value text keeps `!important`; the dom engine's doesn't.
  return Object.fromEntries(
    (declarations as DeclarationStats[]).map((d) => [
      `${d.selector}|${d.property}|${d.value.replace(IMPORTANT_RE, "")}`,
      [d.matched > 0, d.won > 0],
    ]),
  );
};

it("agrees between the CDP and dom usage engines", async () => {
  const stats = async (matcher: "cdp" | "dom") => {
    const outDir = join(dir, `usage-${matcher}`);
    await runUsage({
      ...base(),
      outDir,
      matcher,
      emulate: "cdp",
      states: true,
      settleMs: 50,
    });
    const { declarations } = await Bun.file(join(outDir, "usage.json")).json();
    return Object.fromEntries(
      (declarations as DeclarationStats[]).map((d) => [
        `${d.selector}|${d.property}`,
        [d.matched > 0, d.won > 0],
      ]),
    );
  };
  const cdp = await stats("cdp");
  const dom = await stats("dom");
  expect(dom).toEqual(cdp);
  // Beaten by the more specific `.bx--wrap .bx--btn`.
  expect(cdp[".bx--btn|color"]).toEqual([true, false]);
  // Beaten by `.bx--btn`'s var() shorthand (CDP lists no longhands for it).
  expect(cdp["button|padding"]).toEqual([true, false]);
  // And by a logical one: CDP lists `margin-block-start`, not `margin-top`.
  expect(cdp["button|margin-block-start"]).toEqual([true, false]);
  // The minified @media matches too: CDP spells it `(width >= 1px) and
  // (min-height: 1px)`.
  const reports = await Promise.all(
    ["cdp", "dom"].map((m) =>
      Bun.file(join(dir, `usage-${m}`, "usage.json")).json(),
    ),
  );
  for (const { unmatched } of reports) {
    expect(unmatched.map((r: { selector: string }) => r.selector)).toEqual([
      ".bx--unused",
    ]);
  }
}, 60_000);

it("replays @layer and @scope order the same way Chrome does", async () => {
  const cdp = await usageStats("cdp", "layers");
  const dom = await usageStats("dom", "layers");
  expect(dom).toEqual(cdp);
  expect(cdp).toEqual({
    ".bx--x|color|red": [true, true],
    ".bx--x|color|blue": [true, false],
    "#a.bx--x|color|green": [true, false],
    ".bx--x|top|1px": [true, false],
    "#a.bx--x|top|2px": [true, true],
    ".bx--x|left|1px": [true, true],
    ".bx--x|left|2px": [true, false],
  });
}, 60_000);

it("resolves CSS nesting the same way Chrome does", async () => {
  const cdp = await usageStats("cdp", "nesting");
  const dom = await usageStats("dom", "nesting");
  expect(dom).toEqual(cdp);
  expect(cdp).toEqual({
    ".bx--p|color|red": [true, false],
    ":is(.bx--p,#b) .bx--x|color|blue": [true, true],
    // :is(.bx--p,#b) .bx--x outweighs .bx--p .bx--x.
    ":is(.bx--p,#b) .bx--x|top|1px": [true, true],
    ".bx--p .bx--x|top|2px": [true, false],
    ":is(.bx--p,#b)|left|1px": [true, true],
    ":is(.bx--p,#b)>.bx--x|left|2px": [true, true],
    ":is(.bx--p,#b)|color|green": [true, true],
  });
}, 60_000);

// Every style rule Chrome's CSSOM keeps (nested declarations included), in
// order, as [context, layer, scope, selector text, parent index].
const CSSOM_RULES = `(sheets) => sheets.map((css) => {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  const out = [];
  const walk = (list, ctx, layer, scope, parent) => {
    for (const r of list) {
      if (r instanceof CSSStyleRule) {
        out.push([ctx.join(" / "), layer.join("."), scope.join(" / "), r.selectorText, parent]);
        walk(r.cssRules, ctx, layer, scope, out.length - 1);
      } else if (r instanceof CSSNestedDeclarations) {
        out.push([ctx.join(" / "), layer.join("."), scope.join(" / "), "&", parent]);
      } else if (r instanceof CSSMediaRule) {
        walk(r.cssRules, [...ctx, "@media " + r.media.mediaText], layer, scope, parent);
      } else if (r instanceof CSSSupportsRule) {
        walk(r.cssRules, [...ctx, "@supports " + r.conditionText], layer, scope, parent);
      } else if (r instanceof CSSContainerRule) {
        walk(r.cssRules, [...ctx, "@container " + r.conditionText], layer, scope, parent);
      } else if (r instanceof CSSStartingStyleRule) {
        walk(r.cssRules, [...ctx, "@starting-style"], layer, scope, parent);
      } else if (r instanceof CSSLayerBlockRule) {
        walk(r.cssRules, ctx, [...layer, r.name || "<anonymous>"], scope, parent);
      } else if (r instanceof CSSScopeRule) {
        const s = "@scope (" + r.start + ")" + (r.end ? " to (" + r.end + ")" : "");
        walk(r.cssRules, ctx, layer, [...scope, s], parent);
      }
    }
  };
  walk(sheet.cssRules, [], [], [], -1);
  return out;
})`;

it("reads stylesheets the way Chrome's CSSOM does (fuzz)", async () => {
  const seed = Number(process.env.FUZZ_SEED ?? 12345);
  const runs = Number(process.env.FUZZ_BROWSER_RUNS ?? 500);
  // Not truncated: a value cut off mid-way is invalid, and Chrome drops
  // invalid declarations (a parser can't know which).
  const next = generator(seed, { nesting: true, junk: true, truncate: false });
  // replaceSync takes a string, so strip the BOM a file load would.
  const sheets = Array.from({ length: runs }, () =>
    next().css.replace(BOM_RE, ""),
  );
  const view = new View({ engine: "chrome" });
  try {
    await view.navigate("about:blank");
    const cssom = await view.evaluate<
      [string, string, string, string, number][][]
    >(`(${CSSOM_RULES})(${JSON.stringify(sheets)})`);
    const loose = (s: string) =>
      s.replace(/[\s"'\\]+/g, "").replace(/::/g, ":");
    for (let i = 0; i < runs; i++) {
      // Chrome's selectors are relative to their parent: resolve them the
      // way parseRules does.
      const resolved: ReturnType<typeof parseSelectorList>[] = [];
      const chrome = cssom[i].map(([ctx, layer, scope, text, parent]) => {
        const own = parseSelectorList(text);
        const list =
          parent < 0 ? own : own.map((c) => resolveNested(c, resolved[parent]));
        resolved.push(list);
        return loose(`${ctx}|${layer}|${scope}|${serializeList(list)}`);
      });
      const ours: string[] = [];
      let last = -1;
      for (const r of parseRules(sheets[i])) {
        if (r.context.includes("@keyframes")) continue;
        // One entry per rule, not per selector.
        if (r.order === last) {
          ours[ours.length - 1] += `,${r.selector}`;
          continue;
        }
        last = r.order;
        ours.push(`${r.context}|${r.layer}|${r.scope}|${r.selector}`);
      }
      const mine = ours.map(loose);
      if (!Bun.deepEquals(mine, chrome))
        console.error(
          `fuzz: differs from Chrome for ${JSON.stringify(sheets[i])}`,
        );
      expect(mine).toEqual(chrome);
    }
  } finally {
    view.close();
  }
}, 120_000);
