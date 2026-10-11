/**
 * Impact scoping: `compareCss` reading only what each change can reach,
 * against reading everything, on the stylesheet changes of the Oct 2026
 * audit (its 25 segments of perf/refactor/chore(css) commits, 2d710c03e..
 * 97164eeec) and the golden cases, over today's fixtures: results must be
 * identical, and both are timed. One theme, one viewport, one run at a time,
 * each started once the 1-minute load is below the core count.
 *
 *   CCS_ROOT=… bun eval/carbon/scope.ts [--cases golden|segments|all] [--only <case>] [--concurrency 4]
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, symlink } from "node:fs/promises";
import { availableParallelism, loadavg } from "node:os";
import path from "node:path";
import { $ } from "bun";
import { compareCss, type Impact } from "../../src/browser/compare";
import { pageIndex } from "../../src/browser/page-index";
import {
  atRef,
  CCS_ROOT,
  fixturesDir,
  loadAvg,
  opt,
  results,
  withSass,
} from "./ccs";

const CASES = opt("cases") ?? "all";
const ONLY = opt("only");
const CONCURRENCY = Number(
  opt("concurrency") ?? Math.min(4, Math.floor(availableParallelism() / 2)),
);
const OPT_RE = /^(perf|refactor|chore)(\([^)]*\))?!?:/;
const NON_WORD_RE = /\W+/g;
const OUT = results("scope");
await mkdir(path.join(OUT, "css"), { recursive: true });

interface Case {
  name: string;
  base: string;
  head: string;
  /** Applied to the head ref's CSS. */
  edit?: [string, string];
  /** Checked on the scoped result. */
  expect?: (r: Run) => string | null;
}

type Run = Awaited<ReturnType<typeof compareCss>>;

const git = async (...a: string[]) =>
  (await $`git ${a}`.cwd(CCS_ROOT).quiet().text()).trim();

/** The audit's segments: runs of perf/refactor/chore(css) commits touching css/. */
async function segments(): Promise<Case[]> {
  const log = await git(
    "log",
    "--first-parent",
    "--reverse",
    "--format=%h %s",
    "2d710c03e^..97164eeec",
    "--",
    "css/",
    ":!css/**/*.md",
  );
  const segs: string[][] = [];
  let cur: string[] | null = null;
  for (const line of log.split("\n")) {
    const [sha, subject] = [
      line.slice(0, line.indexOf(" ")),
      line.slice(line.indexOf(" ") + 1),
    ];
    if (!OPT_RE.test(subject)) {
      cur = null;
      continue;
    }
    if (!cur) {
      cur = [];
      segs.push(cur);
    }
    cur.push(sha);
  }
  // The audit left out three segments of component features.
  const skip = new Set([1, 19, 21]);
  return segs.flatMap((s, i) =>
    skip.has(i)
      ? []
      : [{ name: `seg ${i}`, base: `${s[0]}^`, head: s.at(-1) ?? "" }],
  );
}

// One declaration on HEAD: painted only, and moving boxes.
const ONE_RULE: Case[] = [
  {
    name: "one rule: .bx--tag--red color",
    base: "HEAD",
    head: "HEAD",
    edit: [
      ".bx--tag--red {\n  background-color: var(--cds-tag-background-red);\n  color: var(--cds-tag-color-red);",
      ".bx--tag--red {\n  background-color: var(--cds-tag-background-red);\n  color: #a2191f;",
    ],
  },
  {
    name: "one rule: .bx--btn padding",
    base: "HEAD",
    head: "HEAD",
    edit: [
      "  padding: calc(0.875rem - 3px) 63px calc(0.875rem - 3px) 15px;",
      "  padding: calc(0.875rem - 3px) 59px calc(0.875rem - 3px) 15px;",
    ],
  },
];

const GOLDEN: Case[] = [
  {
    name: "regression 28e700f30..7e301af6f",
    base: "28e700f30",
    head: "7e301af6f",
    expect: (r) =>
      r.groups.some(
        (g) =>
          g.property === "color" &&
          g.before === "rgb(22, 22, 22)" &&
          g.after === "rgb(0, 0, 0)" &&
          !g.invisible &&
          g.pages.includes("tooltip-definition.white"),
      )
        ? null
        : "the TooltipDefinition trigger color #161616 -> #000 is missing",
  },
  { name: "intended #3839 660b2936a", base: "660b2936a^", head: "660b2936a" },
  {
    name: "intended flattening ee361d560^..d5e117c9c",
    base: "ee361d560^",
    head: "d5e117c9c",
  },
  {
    name: "fixed later 4de021160..315748acf",
    base: "4de021160",
    head: "315748acf",
  },
  {
    name: "fixed later 31a6ebd6b..87a61d0ec",
    base: "31a6ebd6b",
    head: "87a61d0ec",
  },
  {
    name: "fixed later ff3b54f3e..fdd798606",
    base: "ff3b54f3e",
    head: "fdd798606",
  },
];

/** css/all.scss at `ref`, expanded, cached by commit. */
async function cssAt(ref: string): Promise<string> {
  const sha = await git("rev-parse", "--short=9", ref);
  const file = path.join(OUT, "css", `${sha}.css`);
  if (existsSync(file)) return Bun.file(file).text();
  const css = await atRef(sha, async (cssDir) => {
    // Before 2d710c03e, Carbon came from npm: link it where it's vendored now.
    if (!existsSync(path.join(cssDir, "vendor"))) {
      const npm = results("npm");
      await mkdir(npm, { recursive: true });
      // A package of its own, or bun adds it to the nearest one up.
      if (!existsSync(path.join(npm, "node_modules/carbon-components"))) {
        await Bun.write(path.join(npm, "package.json"), "{}");
        await $`bun add carbon-components@10.58.15`.cwd(npm).quiet();
      }
      await mkdir(path.join(cssDir, "vendor"));
      await symlink(
        path.join(npm, "node_modules/carbon-components"),
        path.join(cssDir, "vendor/carbon-components"),
      );
    }
    return withSass(async (compile) => {
      const r = await compile(cssDir, "all", {
        style: "expanded",
        logger: { warn() {}, debug() {} },
      });
      return r.css;
    });
  });
  await Bun.write(file, css);
  return css;
}

/** Waits until the 1-minute load is below the core count. */
async function quiet(): Promise<void> {
  const cores = availableParallelism();
  for (let waited = 0; loadavg()[0] >= cores; waited += 10) {
    if (waited % 60 === 0)
      console.error(`  waiting for load ${loadAvg()} < ${cores}`);
    // biome-ignore lint/performance/noAwaitInLoops: polling
    await Bun.sleep(10_000);
  }
}

const normalized = (r: Run) =>
  JSON.stringify({
    pages: r.pages.map(({ file, changed, removed, added, uncompared }) => ({
      file,
      changed,
      removed,
      added,
      uncompared,
    })),
    groups: r.groups,
    uncompared: r.uncompared,
    notReady: [...r.notReady].sort(),
    files: r.files,
  });

const dir = await fixturesDir();
const fixtures = (await readdir(dir))
  .filter((f) => f.endsWith(".html"))
  .map((f) => f.slice(0, -".html".length))
  .sort();
const cases = [
  ...(CASES === "segments" || CASES === "golden" ? [] : ONE_RULE),
  ...(CASES === "segments" ? [] : GOLDEN),
  ...(CASES === "golden" ? [] : await segments()),
].filter((c) => !ONLY || c.name.includes(ONLY));

console.log(
  `${cases.length} case(s) on ${fixtures.length} fixtures (white, 1280x900, states), ${CONCURRENCY} tabs`,
);
{
  // The page index, built once (its own directory, so it's never stale).
  await quiet();
  const built = await pageIndex({
    dir,
    fixtures,
    sheetMarker: ".bx--",
    themes: ["white"],
    engine: "chrome",
    emulate: "cdp",
    concurrency: CONCURRENCY,
    readySelector: "#app > *, body > nav",
    cacheDir: path.join(OUT, `index-${Date.now()}`),
  });
  console.log(
    `page index built in ${(built.ms / 1000).toFixed(1)} s (load ${loadAvg()})`,
  );
}
const rows: {
  name: string;
  full: number;
  scoped: number;
  impact: Impact;
  identical: boolean;
  visible: number;
  problem: string | null;
}[] = [];
for (const c of cases) {
  // biome-ignore lint/performance/noAwaitInLoops: one run at a time
  const built = await Promise.all([cssAt(c.base), cssAt(c.head)]).catch(
    (e: Error) => e,
  );
  if (built instanceof Error) {
    console.log(
      `${c.name.padEnd(44)} skipped: ${built.message.split("\n")[0]}`,
    );
    continue;
  }
  const [base, ref] = built;
  const head = c.edit ? ref.replace(c.edit[0], c.edit[1]) : ref;
  if (head === ref && c.edit)
    throw new Error(`${c.name}: the edit doesn't apply`);
  const opts = {
    dir,
    fixtures,
    sheetMarker: ".bx--",
    base,
    head,
    themes: ["white"],
    engine: "chrome" as const,
    states: "cdp" as const,
    emulate: "cdp" as const,
    concurrency: CONCURRENCY,
    readySelector: "#app > *, body > nav",
    indexDir: path.join(OUT, "index"),
  };
  await quiet();
  const full = await compareCss({ ...opts, scope: false });
  await quiet();
  const scoped = await compareCss(opts);
  const identical = normalized(full) === normalized(scoped);
  if (!identical)
    await Bun.write(
      path.join(OUT, `${c.name.replace(NON_WORD_RE, "-")}.json`),
      JSON.stringify(
        {
          full: JSON.parse(normalized(full)),
          scoped: JSON.parse(normalized(scoped)),
        },
        null,
        1,
      ),
    );
  const row = {
    name: c.name,
    full: full.ms,
    scoped: scoped.ms,
    impact: scoped.impact,
    identical,
    visible: scoped.groups
      .filter((g) => !g.invisible)
      .reduce((n, g) => n + g.count, 0),
    problem: c.expect?.(scoped) ?? null,
  };
  rows.push(row);
  console.log(
    `${c.name.padEnd(44)} full ${(row.full / 1000).toFixed(1).padStart(6)} s  scoped ${(row.scoped / 1000).toFixed(1).padStart(6)} s  ${row.impact.everything ? `everything: ${row.impact.everything}` : `${row.impact.pages}/${row.impact.total} pages, ${row.impact.elements} elements`}  ${row.visible} visible  ${identical ? "identical" : "DIFFERENT"}${row.problem ? `  ${row.problem}` : ""}  (load ${loadAvg()})`,
  );
}
const sum = (k: "full" | "scoped") => rows.reduce((n, r) => n + r[k], 0) / 1000;
console.log(
  `\n${rows.length} case(s): full ${sum("full").toFixed(1)} s, scoped ${sum("scoped").toFixed(1)} s (${(sum("full") / sum("scoped")).toFixed(1)}x); ${rows.filter((r) => !r.identical).length} different, ${rows.filter((r) => r.problem).length} failed checks`,
);
await Bun.write(path.join(OUT, "results.json"), JSON.stringify(rows, null, 2));
process.exit(rows.every((r) => r.identical && !r.problem) ? 0 : 1);
