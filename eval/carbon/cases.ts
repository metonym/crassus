// The stylesheet changes the carbon evals run on: runs of CSS refactor
// commits (segments), its golden cases, and one-declaration edits, with each ref's
// css/all.scss compiled (expanded) and cached under .eval/css.
import { existsSync } from "node:fs";
import { mkdir, readdir, symlink } from "node:fs/promises";
import { availableParallelism, loadavg } from "node:os";
import path from "node:path";
import { $ } from "bun";
import type { compareCss } from "../../src/browser/compare";
import {
  atRef,
  CCS_ROOT,
  fixturesDir,
  loadAvg,
  opt,
  results,
  withSass,
} from "./ccs";

const OPT_RE = /^(perf|refactor|chore)(\([^)]*\))?!?:/;
const CSS = results("css");

export const CONCURRENCY = Number(
  opt("concurrency") ?? Math.min(4, Math.floor(availableParallelism() / 2)),
);

export type Run = Awaited<ReturnType<typeof compareCss>>;

export interface Case {
  name: string;
  base: string;
  head: string;
  /** Applied to the head ref's CSS. */
  edit?: [string, string];
  /** Checked on the scoped result. */
  expect?: (r: Run) => string | null;
}

const git = async (...a: string[]) =>
  (await $`git ${a}`.cwd(CCS_ROOT).quiet().text()).trim();

/** Segments: runs of perf/refactor/chore(css) commits touching css/. */
export async function segments(): Promise<Case[]> {
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
  // Three segments are component features, not refactors: left out.
  const skip = new Set([1, 19, 21]);
  return segs.flatMap((s, i) =>
    skip.has(i)
      ? []
      : [{ name: `seg ${i}`, base: `${s[0]}^`, head: s.at(-1) ?? "" }],
  );
}

// One declaration on HEAD: painted only, and moving boxes.
export const ONE_RULE: Case[] = [
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

export const GOLDEN: Case[] = [
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
export async function cssAt(ref: string): Promise<string> {
  const sha = await git("rev-parse", "--short=9", ref);
  await mkdir(CSS, { recursive: true });
  const file = path.join(CSS, `${sha}.css`);
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
export async function quiet(): Promise<void> {
  const cores = availableParallelism();
  for (let waited = 0; loadavg()[0] >= cores; waited += 10) {
    if (waited % 60 === 0)
      console.error(`  waiting for load ${loadAvg()} < ${cores}`);
    // biome-ignore lint/performance/noAwaitInLoops: polling
    await Bun.sleep(10_000);
  }
}

/** The built fixtures, with the options every run on them shares (white, 1280x900). */
export async function fixtureOpts(concurrency = CONCURRENCY) {
  const dir = await fixturesDir();
  const fixtures = (await readdir(dir))
    .filter((f) => f.endsWith(".html"))
    .map((f) => f.slice(0, -".html".length))
    .sort();
  return {
    dir,
    fixtures,
    sheetMarker: ".bx--",
    themes: ["white"],
    engine: "chrome" as const,
    emulate: "cdp" as const,
    concurrency,
    readySelector: "#app > *, body > nav",
    indexDir: results("scope", "index"),
  };
}
