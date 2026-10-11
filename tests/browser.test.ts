// Needs Chrome: Playwright's chrome-headless-shell if installed, else what
// Bun.WebView auto-detects (GitHub's ubuntu runners ship Chrome).
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRules, resolvePath } from "crassus";
import {
  capture,
  compareCss,
  diffSnapshots,
  type Impact,
  readSnapshot,
  runUsage,
  serveFixtures,
  type UsageFile,
} from "crassus/browser";
import { capturePage, checkDisk } from "../src/browser/snapshot";
import { headlessShell, View, visitPages } from "../src/browser/view";
import {
  parseSelectorList,
  resolveNested,
  serializeList,
} from "../src/core/selector";
import type { DeclarationStats } from "../src/core/usage";
import { generator, loose } from "./fuzz-gen";

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

const ORDER = ["hover", "focus", "active"];
const IMPORTANT_RE = /\s*!important$/;
const STATE_KEY_RE = /\.bx--s\.(\w+)@(\w+)$/;
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

const LATE_PAGE = `<!doctype html><html><head><style>.bx--late { color: red; }</style></head>
<body><script>setTimeout(() => { const p = document.createElement("p"); p.className = "bx--late"; document.body.append(p); }, 200);</script></body></html>`;

const DIFF_PAGE = `<!doctype html><html><head><link rel="stylesheet" href="diff.css"></head>
<body><div class="bx--d"><p class="bx--d">a</p><p class="bx--d">b</p></div><span class="bx--e">c</span></body></html>`;
const diffCss = (color: string) =>
  `.bx--d { color: ${color}; margin: 0; } .bx--e { color: green; }`;

// Forced states only where a user can reach them.
const STATES_PAGE = `<!doctype html><html><head><style>.bx--s { color: red; }</style></head>
<body><button class="bx--s ok">x</button><button class="bx--s disabled" disabled>x</button>
<a class="bx--s nohref">x</a><a class="bx--s href" href="#">x</a><ul><li class="bx--s li">x</li></ul>
<div class="bx--s tab" tabindex="-1">x</div><div inert><button class="bx--s inert">x</button></div>
<button class="bx--s hidden" style="visibility: hidden">x</button></body></html>`;

// A spinner, a fade-in that has ended, and one that runs for 100 s.
const ANIMATED_PAGE = `<!doctype html><html><head><style>
@keyframes bx-spin { to { transform: rotate(360deg); } }
@keyframes bx-fade { from { opacity: 0; } to { opacity: 1; } }
.bx--spin { animation: bx-spin 690ms linear infinite; transform: none; }
.bx--fade { animation: bx-fade 1ms forwards; opacity: 0.5; }
.bx--slow { animation: bx-fade 100s; opacity: 0.5; }
</style></head><body><p class="bx--spin">x</p><p class="bx--fade">x</p><p class="bx--slow">x</p></body></html>`;

// One color change, as an audit saw it: a border declared both ways, color
// with its currentColor followers, a border of width 0, a hidden subtree.
const foldCss = (c: string) => `
.bx--f { border: 1px solid ${c}; border-block-start-color: ${c}; border-inline-end-color: ${c}; color: black; }
.bx--g { color: ${c}; outline: 0 none; caret-color: currentColor; }
.bx--h { border-top-color: ${c}; }
.bx--x { display: none; } .bx--x p { color: ${c}; }`;
const FOLD_PAGE = `<!doctype html><html><head><link rel="stylesheet" href="fold.css"></head>
<body><div class="bx--f">a</div><div class="bx--g">b</div><div class="bx--h">c</div><div class="bx--x"><p>d</p></div></body></html>`;

const SITE = {
  "states.html": STATES_PAGE,
  "animated.html": ANIMATED_PAGE,
  "lib.css": LIB_CSS,
  "page.html": PAGE,
  "layers.css": LAYERS_CSS,
  "layers.html": LAYERS_PAGE,
  "nesting.css": NESTING_CSS,
  "nesting.html": NESTING_PAGE,
  "viewport.css": VIEWPORT_CSS,
  "viewport.html": VIEWPORT_PAGE,
  "late.html": LATE_PAGE,
};

let dir = "";
let server: ReturnType<typeof serveFixtures>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "crassus-browser-"));
  await Promise.all(
    Object.entries(SITE).map(([file, text]) =>
      Bun.write(join(dir, "site", file), text),
    ),
  );
  server = serveFixtures(join(dir, "site"));
});

afterAll(async () => {
  server.stop();
  Bun.WebView.closeAll();
  await rm(dir, { recursive: true, force: true });
});

const readJson = <T>(...path: string[]): Promise<T> =>
  Bun.file(join(...path)).json();

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
  const cdp = await readSnapshot(join(dir, "cdp", "page.white.json.gz"));
  const rewrite = await readSnapshot(
    join(dir, "rewrite", "page.white.json.gz"),
  );
  expect(rewrite).toEqual(cdp);
  const hovered = Object.entries(cdp).find(([key]) =>
    key.endsWith("button.bx--btn@hover"),
  );
  expect(hovered).toBeDefined();
  expect(hovered?.[1].color).toBe("rgb(0, 128, 0)");
}, 60_000);

it("forces only the states a user can reach, in both modes", async () => {
  const reached: Record<string, string[]>[] = [];
  for (const states of ["cdp", "rewrite"] as const) {
    const outDir = join(dir, `snap-states-${states}`);
    // biome-ignore lint/performance/noAwaitInLoops: one browser, sequential captures
    await capture({
      ...base(),
      fixtures: ["states"],
      outDir,
      states,
      emulate: "cdp",
      settleMs: 0,
    });
    const snap = await readSnapshot(join(outDir, "states.white.json.gz"));
    const by: Record<string, string[]> = {};
    for (const key of Object.keys(snap)) {
      const m = STATE_KEY_RE.exec(key);
      if (m) by[m[1]] = [...(by[m[1]] ?? []), m[2]];
    }
    // In STATE_SETS order, however they were read.
    for (const list of Object.values(by))
      list.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
    reached.push(by);
  }
  expect(reached[0]).toEqual({
    ok: ["hover", "focus", "active"],
    disabled: ["hover"],
    nohref: ["hover", "active"],
    href: ["hover", "focus", "active"],
    li: ["hover", "active"],
    tab: ["hover", "focus", "active"],
    hidden: ["hover", "active"],
  });
  expect(reached[1]).toEqual(reached[0]);
}, 60_000);

it("freezes running animations before reading styles", async () => {
  const read = async (settleMs: number) => {
    const outDir = join(dir, `snap-animated-${settleMs}`);
    await capture({
      ...base(),
      fixtures: ["animated"],
      outDir,
      states: false,
      emulate: "cdp",
      settleMs,
    });
    return readSnapshot(join(outDir, "animated.white.json.gz"));
  };
  const early = await read(20);
  // Half a turn later.
  const late = await read(365);
  expect(late).toEqual(early);
  expect(early["body>p.bx--spin"].transform).toBe("matrix(1, 0, 0, 1, 0, 0)");
  expect(early["body>p.bx--fade"].opacity).toBe("1");
  expect(early["body>p.bx--slow"].opacity).toBe("0.5");
}, 60_000);

it("diffSnapshots folds one cause into one change, and marks what no one sees", async () => {
  const sides = [
    ["fold-base", "red"],
    ["fold-head", "blue"],
  ] as const;
  await Promise.all(
    sides.flatMap(([side, color]) => [
      Bun.write(join(dir, side, "fold.css"), foldCss(color)),
      Bun.write(join(dir, side, "fold.html"), FOLD_PAGE),
    ]),
  );
  for (const [side] of sides) {
    const site = serveFixtures(join(dir, side));
    try {
      // biome-ignore lint/performance/noAwaitInLoops: one browser, sequential captures
      await capture({
        ...base(),
        baseUrl: site.url,
        fixtures: ["fold"],
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
    join(dir, "snap-fold-base"),
    join(dir, "snap-fold-head"),
  );
  const RED = "rgb(255, 0, 0)";
  const BLUE = "rgb(0, 0, 255)";
  expect(
    diff.groups.map((g) => [
      g.property,
      g.before,
      g.after,
      g.invisible,
      g.examples[0].path,
    ]),
  ).toEqual([
    ["border-color", RED, BLUE, undefined, "body>div.bx--f"],
    ["color", RED, BLUE, undefined, "body>div.bx--g"],
    ["border-top-color", RED, BLUE, "no border", "body>div.bx--h"],
    ["color", RED, BLUE, "display: none", "body>div.bx--x>p"],
  ]);
  // The physical sides, and the logical ones the stylesheet declares.
  expect(diff.groups[0].aliases).toEqual([
    "border-block-start-color",
    "border-bottom-color",
    "border-inline-end-color",
    "border-left-color",
    "border-right-color",
    "border-top-color",
  ]);
  expect(diff.groups[1].aliases).toEqual(
    expect.arrayContaining([
      "caret-color",
      "outline-color",
      "border-top-color",
    ]),
  );
}, 60_000);

it("compareCss diffs two stylesheets on the same pages, forced states included", async () => {
  const opts = {
    ...base(),
    dir: join(dir, "site"),
    states: "cdp" as const,
    emulate: "cdp" as const,
    settleMs: 0,
  };
  const same = await compareCss({ ...opts, base: LIB_CSS, head: LIB_CSS });
  expect(same.files).toBe(1);
  expect(same.groups).toEqual([]);
  expect(same.pages).toEqual([]);

  const diff = await compareCss({
    ...opts,
    base: LIB_CSS,
    head: LIB_CSS.replace("color: green", "color: lime"),
  });
  expect(diff.groups).toEqual([
    expect.objectContaining({
      property: "color",
      before: "rgb(0, 128, 0)",
      after: "rgb(0, 255, 0)",
      count: 1,
      pages: ["page.white"],
      examples: [
        { page: "page.white", path: "body>div.bx--wrap>button.bx--btn@hover" },
      ],
    }),
  ]);
}, 60_000);

// What scoped compares must still see: a change on hover, inherited by
// descendants, on a pseudo-element, a box that moves an absolute sibling,
// a rule on <body>, and pages none of it reaches.
const SCOPE_CSS = `
.bx--card { color: black; padding: 4px; position: relative; }
.bx--card:hover .bx--title { background-color: white; }
.bx--title::before { content: ""; border-top: 1px solid red; }
.bx--pin { position: absolute; top: auto; }
.bx--list li:nth-child(2n) { color: gray; }
.bx--other { color: black; }
body { letter-spacing: 0; }`;
const SCOPE_PAGES = {
  "card.html": `<div class="bx--card" role="group"><h2 class="bx--title">t<span>s</span></h2></div><p>x</p><div class="bx--pin">p</div>`,
  "list.html": `<ul class="bx--list"><li>a</li><li tabindex="0">b</li><li>c</li></ul>`,
  "other.html": `<p class="bx--other">o</p>`,
};

it("compareCss reads only what the change reaches, with the same results", async () => {
  const root = join(dir, "scope");
  await Promise.all([
    Bun.write(join(root, "lib.css"), SCOPE_CSS),
    ...Object.entries(SCOPE_PAGES).map(([file, body]) =>
      Bun.write(
        join(root, file),
        `<!doctype html><html><head><link rel="stylesheet" href="lib.css"></head><body>${body}</body></html>`,
      ),
    ),
  ]);
  const opts = {
    ...base(),
    dir: root,
    fixtures: ["card", "list", "other"],
    states: "cdp" as const,
    emulate: "cdp" as const,
    settleMs: 0,
    indexDir: join(dir, "scope-index"),
    base: SCOPE_CSS,
  };
  const edits: [string, string, number][] = [
    // [from, to, pages the change reaches]
    ["background-color: white", "background-color: yellow", 1],
    ["color: black; padding", "color: navy; padding", 1],
    ["border-top: 1px solid red", "border-top: 2px dashed red", 1],
    ["padding: 4px", "padding: 9px", 1],
    ["color: gray", "color: silver", 1],
    ["letter-spacing: 0", "letter-spacing: 1px", 3],
    [".bx--pin { position: absolute; top: auto; }", "", 1],
  ];
  for (const [i, [from, to, pages]] of edits.entries()) {
    const head = SCOPE_CSS.replace(from, to);
    let impact: Impact | undefined;
    // biome-ignore lint/performance/noAwaitInLoops: one browser, sequential runs
    const full = await compareCss({ ...opts, head, scope: false });
    const scoped = await compareCss({
      ...opts,
      head,
      onImpact: (i) => {
        impact = i;
      },
    });
    expect({ edit: from, groups: scoped.groups, pages: scoped.pages }).toEqual({
      edit: from,
      groups: full.groups,
      pages: full.pages,
    });
    expect({ edit: from, changed: full.groups.length > 0 }).toEqual({
      edit: from,
      changed: true,
    });
    // Built by the first scoped run, read after.
    expect(impact).toMatchObject({
      total: 3,
      pages,
      index: i === 0 ? "built" : "cached",
    });
    expect(scoped.impact).toEqual(impact);
    expect(full.impact.everything).toBe("scope is off");
  }
}, 120_000);

it("records boxes no one can see: offscreen, or clipped by an overflow ancestor", async () => {
  const root = join(dir, "geometry");
  await Bun.write(
    join(root, "page.html"),
    `<!doctype html><html><body>
<div class="clip" style="overflow: hidden; height: 20px"><p class="below" style="margin-top: 50px">x</p><p class="abs" style="position: absolute; top: 60px">y</p></div>
<p class="away" style="position: absolute; left: -9999px">z</p><p class="seen">w</p></body></html>`,
  );
  const site = serveFixtures(root);
  try {
    const outDir = join(dir, "snap-geometry");
    await capture({
      ...base(),
      baseUrl: site.url,
      outDir,
      states: false,
      emulate: "cdp",
      settleMs: 0,
    });
    const snap = await readSnapshot(join(outDir, "page.white.json.gz"));
    const hidden = Object.fromEntries(
      Object.entries(snap).map(([k, r]) => [k, r["--cr-hidden"] ?? null]),
    );
    expect(hidden).toEqual({
      "body>div.clip": null,
      "body>div.clip>p.below": "clipped by an overflow ancestor",
      // Positioned: it may escape the clip, so it isn't claimed.
      "body>div.clip>p.abs": null,
      "body>p.away": "offscreen",
      "body>p.seen": null,
    });
  } finally {
    site.stop();
  }
}, 60_000);

/** Serves `html` as `<name>/page.html`; `read` loads it and captures forced states. */
async function withStates(
  name: string,
  html: string,
  fn: (
    read: (stateIndex?: boolean) => ReturnType<typeof capturePage>,
  ) => Promise<void>,
) {
  const root = join(dir, name);
  await Bun.write(join(root, "page.html"), html);
  const site = serveFixtures(root);
  const view = new View({ engine: "chrome" });
  try {
    await fn(async (stateIndex) => {
      await view.navigate(`${site.url}/page.html`);
      return capturePage(view, {
        states: "cdp",
        emulate: "cdp",
        settleMs: 0,
        stateIndex,
      });
    });
  } finally {
    view.close();
    site.stop();
  }
}

it("reads states no rule uses unforced, with the same records as forcing them", async () => {
  await withStates(
    "state-index",
    `<!doctype html><html><head><style>
.card:hover .title { color: red; }
.row:focus-within { background: yellow; }
.list:has(li:hover) { border: 1px solid; }
a:active { text-decoration: underline; }
</style></head><body>
<div class="card" role="group"><h2 class="title">t</h2><button>b</button></div>
<div class="row"><input></div>
<ul class="list"><li>one</li><li>two</li></ul>
<a href="#">link</a><span tabindex="0">plain</span><label>label</label>
</body></html>`,
    async (read) => {
      const every = await read(false);
      const indexed = await read(true);
      expect(indexed.snapshot).toEqual(every.snapshot);
      // `label` and the `span` are hovered and activated by no rule.
      expect(indexed.stats?.copied).toBeGreaterThan(0);
      expect(indexed.stats?.cdpCalls).toBeLessThan(every.stats?.cdpCalls ?? 0);
      expect(every.stats?.copied).toBe(0);
    },
  );
}, 60_000);

it("swaps the largest stylesheet that contains the marker", async () => {
  const root = join(dir, "swap");
  await Promise.all([
    Bun.write(
      join(root, "assets/lib.css"),
      ".bx--a { color: red; } /* long */",
    ),
    Bun.write(join(root, "assets/extra.css"), ".bx--b { color: red; }"),
    Bun.write(join(root, "big.css"), `.app { color: red; ${" ".repeat(99)}}`),
  ]);
  const site = serveFixtures(root, { swap: { marker: ".bx--", css: ".x{}" } });
  try {
    const get = (p: string) => fetch(`${site.url}/${p}`).then((r) => r.text());
    expect(await get("assets/lib.css")).toBe(".x{}");
    expect(await get("assets/extra.css")).toBe(".bx--b { color: red; }");
    expect(await get("big.css")).toContain(".app");
  } finally {
    site.stop();
  }
  expect(() =>
    serveFixtures(root, { swap: { marker: ".nope--", css: "" } }),
  ).toThrow("no .css file under");
});

it("resolves every captured path to its element", async () => {
  const outDir = join(dir, "snap-resolve");
  await capture({
    ...base(),
    fixtures: ["states"],
    outDir,
    states: false,
    emulate: "cdp",
    settleMs: 0,
  });
  const snap = await readSnapshot(join(outDir, "states.white.json.gz"));
  const view = new View({ engine: "chrome" });
  try {
    await view.navigate(`${server.url}/states.html`);
    const colors = await view.evaluate<(string | null)[]>(
      `${JSON.stringify(Object.keys(snap))}.map((key) => {
        const el = (${resolvePath})(key, document.documentElement);
        return el && getComputedStyle(el).color;
      })`,
    );
    expect(colors).toEqual(Object.values(snap).map((r) => r.color));
  } finally {
    view.close();
  }
}, 60_000);

it("compareCss explains winners and compares element screenshots", async () => {
  const css = (wrap: string, btn: string, hover: string) => `
.bx--wrap { color: ${wrap}; padding: 4px; }
.bx--btn { color: ${btn}; border: 2px solid currentColor; }
.bx--btn.bx--btn { color: inherit; }
.bx--btn:hover { background-color: ${hover}; }
.bx--hidden { visibility: hidden; color: ${btn}; }
.bx--none { display: none; }`;
  const root = join(dir, "explain");
  await Promise.all([
    Bun.write(join(root, "lib.css"), css("black", "red", "yellow")),
    Bun.write(
      join(root, "page.html"),
      `<!doctype html><html><head><link rel="stylesheet" href="lib.css"></head><body><div class="bx--wrap"><button class="bx--btn">Go</button></div><p class="bx--hidden">x</p><div class="bx--none"><button class="bx--btn">No</button></div></body></html>`,
    ),
  ]);
  const diff = await compareCss({
    ...base(),
    dir: root,
    base: css("black", "red", "yellow"),
    // The button's color now comes from its own rule, not inheritance.
    head: css("black", "red", "orange").replace(
      ".bx--btn.bx--btn { color: inherit; }",
      ".bx--btn.bx--btn { color: green; }",
    ),
    states: "cdp",
    emulate: "cdp",
    settleMs: 0,
    explain: true,
    visual: true,
  });
  expect(diff.library).toBe("lib.css");
  // Proven unseen (display: none): no screenshot taken to say so.
  const hidden = diff.groups.find((g) => g.invisible === "display: none");
  expect(hidden).toBeDefined();
  expect(hidden?.pixels).toBeUndefined();
  const visible = (property: string) =>
    diff.groups.find((g) => g.property === property && !g.invisible);
  const color = visible("color");
  const background = visible("background-color");
  expect(color).toMatchObject({
    property: "color",
    after: "rgb(0, 128, 0)",
    // The button, and its forced :hover, :focus and :active.
    pixels: { differ: 4, same: 0 },
  });
  expect(color?.examples[0]).toEqual({
    page: "page.white",
    path: "body>div.bx--wrap>button.bx--btn",
    explain: {
      // `color: inherit` hands it to the wrapper.
      base: {
        selector: ".bx--wrap",
        sheet: "lib.css",
        line: 2,
        column: 0,
        inherited: true,
      },
      // Edited between the sides: the card's root cause.
      head: {
        selector: ".bx--btn.bx--btn",
        sheet: "lib.css",
        line: 4,
        column: 0,
        changed: true,
      },
    },
  });
  expect(background).toMatchObject({
    property: "background-color",
    pixels: { differ: 1, same: 0 },
    examples: [
      {
        path: "body>div.bx--wrap>button.bx--btn@hover",
        explain: {
          base: { selector: ".bx--btn:hover", line: 5 },
          head: { selector: ".bx--btn:hover", line: 5 },
        },
      },
    ],
  });
  // Unchanged CSS with an inherited winner, for the record.
  const same = await compareCss({
    ...base(),
    dir: root,
    base: css("black", "red", "yellow"),
    head: css("blue", "red", "yellow"),
    states: false,
    emulate: "cdp",
    settleMs: 0,
    explain: true,
    visual: true,
  });
  const wrap = same.groups.find((g) => g.property === "color");
  expect(wrap?.pixels).toEqual({ differ: 2, same: 0, imperceptible: 0 });
  // Black to blue text: plain to see.
  expect(wrap?.deltaE?.max).toBeGreaterThan(30);
  expect(same.pages[0].explain?.["body>div.bx--wrap>button.bx--btn"]).toEqual({
    color: {
      base: {
        selector: ".bx--wrap",
        sheet: "lib.css",
        line: 2,
        column: 0,
        inherited: true,
        changed: true,
      },
      head: {
        selector: ".bx--wrap",
        sheet: "lib.css",
        line: 2,
        column: 0,
        inherited: true,
        changed: true,
      },
    },
  });
  // One step off black: the pixels differ, by less than anyone can see.
  const faint = await compareCss({
    ...base(),
    dir: root,
    base: css("black", "red", "yellow"),
    head: css("rgb(1, 1, 1)", "red", "yellow"),
    states: false,
    emulate: "cdp",
    settleMs: 0,
    visual: true,
  });
  const step = faint.groups.find((g) => g.property === "color");
  expect(step?.pixels).toMatchObject({ differ: 2, imperceptible: 2 });
  expect(step?.deltaE?.max).toBeLessThan(1);
}, 60_000);

it("stops the pool at the first failure", async () => {
  let started = 0;
  const run = visitPages(
    {
      ...base(),
      fixtures: ["page", "page", "page", "page"],
      concurrency: 2,
      emulate: "cdp",
    },
    async () => {
      if (++started === 1) throw new Error("boom");
      await Bun.sleep(50);
    },
  );
  await expect(run).rejects.toThrow("boom");
  // The other view finished its page and took no more (under load it
  // backs off, sees the failure and starts none).
  await Bun.sleep(200);
  expect(started).toBeLessThanOrEqual(2);
}, 60_000);

it("checkDisk stops a capture that would fill the disk", async () => {
  // 1 PB per page.
  await expect(checkDisk(dir, 2 ** 50, 1, 2)).rejects.toMatchObject({
    code: "ENOSPC",
    message: expect.stringContaining("1 more page(s) need about"),
  });
  await checkDisk(dir, 1, 1, 2);
  // Nothing left to write: no check.
  await checkDisk(dir, 2 ** 50, 2, 2);
});

it("finds Playwright's newest chrome-headless-shell", async () => {
  const cache = join(dir, "ms-playwright");
  const exe = process.platform === "win32" ? ".exe" : "";
  const shell = (rev: number) =>
    join(
      cache,
      `chromium_headless_shell-${rev}`,
      "chrome-headless-shell-x",
      `chrome-headless-shell${exe}`,
    );
  await Promise.all([
    Bun.write(shell(1100), ""),
    Bun.write(shell(1243), ""),
    Bun.write(join(cache, "chromium-1300", "chrome-mac", "Chromium"), ""),
  ]);
  const saved = process.env.PLAYWRIGHT_BROWSERS_PATH;
  try {
    process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
    expect(headlessShell()).toBe(shell(1243));
    process.env.PLAYWRIGHT_BROWSERS_PATH = join(dir, "nowhere");
    expect(headlessShell()).toBeUndefined();
  } finally {
    if (saved === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = saved;
  }
});

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
  expect(diff.onlyHead).toEqual(["extra.white.json.gz"]);
  expect(diff.files).toBe(1);
  expect(diff.groups).toEqual([
    {
      property: "color",
      before: "rgb(0, 0, 255)",
      after: "rgb(128, 0, 128)",
      count: 3,
      pages: ["diff.white.json.gz"],
      examples: [
        { page: "diff.white.json.gz", path: "body>div.bx--d" },
        { page: "diff.white.json.gz", path: "body>div.bx--d>p.bx--d" },
        { page: "diff.white.json.gz", path: "body>div.bx--d>p.bx--d[1]" },
      ],
    },
  ]);
  expect(diff.pages).toMatchObject([
    {
      file: "diff.white.json.gz",
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
    ".crassus-capture",
    "viewport.white.1280x900.json.gz",
    "viewport.white.320x640.json.gz",
  ]);
  const style = async (file: string, out = outDir) =>
    (await readSnapshot(join(out, file)))["body>p.bx--v"];
  const narrow = await style("viewport.white.320x640.json.gz");
  const wide = await style("viewport.white.1280x900.json.gz");
  expect(narrow.color).toBe("rgb(0, 0, 255)");
  expect(wide.color).toBe("rgb(255, 0, 0)");
  // The page gets the whole viewport: Chrome's window size includes its UI.
  expect(narrow.height).toBe("640px");
  expect(wide.height).toBe("900px");
  await capture({
    ...base(),
    fixtures: ["viewport"],
    outDir: join(dir, "snap-default-viewport"),
    states: false,
    emulate: "cdp",
    settleMs: 0,
  });
  expect(
    (await style("viewport.white.json.gz", join(dir, "snap-default-viewport")))
      .height,
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
    const { unmatched } = await readJson<UsageFile>(out, "usage.json");
    return unmatched.map((r) => r.context);
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
  const snap = await readSnapshot(join(outDir, "late.white.json.gz"));
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

const usageReport = async (matcher: "cdp" | "dom", page = "page") => {
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
  return readJson<UsageFile>(outDir, "usage.json");
};

/** [matched, won] per declaration. */
const outcomes = (
  { declarations }: UsageFile,
  key: (d: DeclarationStats) => string,
) =>
  Object.fromEntries(
    declarations.map((d) => [key(d), [d.matched > 0, d.won > 0]]),
  );

/** Outcomes by selector, property and value, checked equal across engines. */
const agreedOutcomes = async (page: string) => {
  // CDP's value text keeps `!important`; the dom engine's doesn't.
  const key = (d: DeclarationStats) =>
    `${d.selector}|${d.property}|${d.value.replace(IMPORTANT_RE, "")}`;
  const cdp = outcomes(await usageReport("cdp", page), key);
  const dom = outcomes(await usageReport("dom", page), key);
  expect(dom).toEqual(cdp);
  return cdp;
};

it("agrees between the CDP and dom usage engines", async () => {
  const reports = [await usageReport("cdp"), await usageReport("dom")];
  const [cdp, dom] = reports.map((r) =>
    outcomes(r, (d) => `${d.selector}|${d.property}`),
  );
  expect(dom).toEqual(cdp);
  // Beaten by the more specific `.bx--wrap .bx--btn`.
  expect(cdp[".bx--btn|color"]).toEqual([true, false]);
  // Beaten by `.bx--btn`'s var() shorthand (CDP lists no longhands for it).
  expect(cdp["button|padding"]).toEqual([true, false]);
  // And by a logical one: CDP lists `margin-block-start`, not `margin-top`.
  expect(cdp["button|margin-block-start"]).toEqual([true, false]);
  // The minified @media matches too: CDP spells it `(width >= 1px) and
  // (min-height: 1px)`.
  for (const { unmatched } of reports) {
    expect(unmatched.map((r) => r.selector)).toEqual([".bx--unused"]);
  }
}, 60_000);

it("replays @layer and @scope order the same way Chrome does", async () => {
  expect(await agreedOutcomes("layers")).toEqual({
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
  expect(await agreedOutcomes("nesting")).toEqual({
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
