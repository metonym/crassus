import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { readSnapshot, type UsageFile } from "crassus/browser";
import { type BisectResult, found, segments } from "../src/cli/bisect";
import { main } from "../src/cli/main";
import { appendSummary } from "../src/cli/report";

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "crassus-cli-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(dir, "p-"));
  await Promise.all(
    Object.entries(files).map(([f, text]) => Bun.write(join(root, f), text)),
  );
  return root;
}

async function cli(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    cwd,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const read = (root: string, file: string) => Bun.file(join(root, file)).text();

async function commitAll(root: string) {
  const git = (...args: string[]) =>
    $`git -c user.email=t@t -c user.name=t ${args}`.cwd(root).quiet();
  await git("init", "-q");
  await git("add", ".");
  await git("commit", "-q", "-m", "base");
}

const worktrees = async (root: string) =>
  (await $`git worktree list`.cwd(root).text()).trim().split("\n").length;

// `.a { color: red }` at line 1 of a.scss, `.a { color: blue }` at line 3.
const MAPPED_CSS = ".a {\n  color: red;\n}\n.a {\n  color: blue;\n}\n";
const MAP = JSON.stringify({
  version: 3,
  sources: ["../src/a.scss"],
  names: [],
  mappings: "AAAA;EACE;;AAEF;EACE",
});

describe("crassus dead", () => {
  it("reports dead declarations at their source and exits 1", async () => {
    const root = await project({
      "dist/a.css": MAPPED_CSS,
      "dist/a.css.map": MAP,
    });
    const r = await cli(root, "dead", "dist/a.css");
    expect(r.code).toBe(1);
    expect(r.out).toContain("src/a.scss:2");
    expect(r.out).toContain("color: red  <-  color: blue");
    expect(r.out).toContain("1 dead declaration(s)");
  });

  it("reads inline source maps, and falls back to the CSS file", async () => {
    const inline = `${MAPPED_CSS}/*# sourceMappingURL=data:application/json;base64,${btoa(MAP)} */`;
    const root = await project({ "dist/a.css": inline, "b.css": MAPPED_CSS });
    expect((await cli(root, "dead", "dist/a.css")).out).toContain(
      "src/a.scss:2",
    );
    expect((await cli(root, "dead", "b.css")).out).toContain("b.css:2");
  });

  it("exits 0 when clean", async () => {
    const root = await project({ "a.css": ".a { color: red }" });
    const r = await cli(root, "dead", "a.css");
    expect(r.code).toBe(0);
    expect(r.out).toContain("0 dead declaration(s)");
  });

  it("speaks json, github and sarif", async () => {
    const root = await project({
      "dist/a.css": MAPPED_CSS,
      "dist/a.css.map": MAP,
    });
    const json = JSON.parse(
      (await cli(root, "dead", "dist/a.css", "--json")).out,
    );
    expect(json.schema).toBe(1);
    expect(json.results[0].dead[0]).toEqual(
      expect.objectContaining({
        selector: ".a",
        property: "color",
        source: { file: "src/a.scss", line: 2, column: 2 },
      }),
    );
    const github = (await cli(root, "dead", "dist/a.css", "--format", "github"))
      .out;
    expect(
      github.startsWith(
        "::error file=src/a.scss,line=2,col=3,title=crassus%3A dead declaration (proof%2C dist/a.css)::",
      ),
    ).toBe(true);
    const sarif = JSON.parse(
      (await cli(root, "dead", "dist/a.css", "--format=sarif")).out,
    );
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].results[0]).toEqual(
      expect.objectContaining({
        ruleId: "dead-declaration",
        level: "error",
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: "src/a.scss" },
              region: { startLine: 2, startColumn: 3 },
            },
          },
        ],
      }),
    );
  });

  it("uses the config's css and build command, by entry", async () => {
    const root = await project({
      "crassus.config.ts": `export default {
        css: { main: "out/main.css", extra: "out/extra.css" },
        build: "mkdir -p out && printf '.a{color:red}.a{color:blue}' > out/main.css && printf '.b{top:0}' > out/extra.css",
      };`,
    });
    const r = await cli(root, "dead", "--json");
    expect(r.code).toBe(1);
    const { results } = JSON.parse(r.out);
    expect(results.map((x: { entry: string }) => x.entry)).toEqual([
      "main",
      "extra",
    ]);
    const only = JSON.parse(
      (await cli(root, "dead", "--json", "--entry", "extra")).out,
    );
    expect(only.results.length).toBe(1);
  });

  it("uses a compile hook", async () => {
    const root = await project({
      "crassus.config.ts": `export default {
        compile: (root) => ({ app: { css: ".a{color:red}.a{color:blue}" } }),
      };`,
    });
    const r = await cli(root, "dead");
    expect(r.code).toBe(1);
    expect(r.out).toContain("in app");
  });
});

describe("usage errors exit 2", () => {
  it.each([
    [["nope"], "unknown command"],
    [["dead", "--nope"], "Unknown option"],
    [["dead", "missing.css"], "no such file"],
    [["dead"], "no stylesheets"],
    [["dead", "a.css", "--format", "xml"], "unknown format"],
    [["diff", "a.css"], "diff takes two files"],
  ])("%j", async (argv, message) => {
    const root = await project({ "a.css": ".a{}" });
    const r = await cli(root, ...argv);
    expect(r.code).toBe(2);
    expect(r.err).toContain(message);
  });

  it("names the entries there are", async () => {
    const root = await project({
      "crassus.config.ts": `export default { compile: () => ({ app: { css: "" } }) };`,
    });
    const r = await cli(root, "dead", "--entry", "web");
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown entry web (have: app)");
  });

  it("prints help", async () => {
    expect((await cli(dir, "--help")).out).toContain("crassus dead");
    expect((await cli(dir)).code).toBe(2);
  });
});

const CUT_NOTE_RE =
  /\n… \d+ more line\(s\) cut to fit GitHub's 1 MiB step summary; run crassus locally for the full report.\n```\n$/;

describe("crassus diff", () => {
  const BASE = ".a .x { color: red }\n.x { color: blue }\n";
  // :where() drops `.a .x` to (0,1,0): `.x` now wins on order.
  const HEAD = ":where(.a) .x { color: red }\n.x { color: blue }\n";

  it("compares two files, failing on a cascade flip", async () => {
    const root = await project({ "base.css": BASE, "head.css": HEAD });
    const r = await cli(root, "diff", "base.css", "head.css");
    expect(r.code).toBe(1);
    expect(r.out).toContain("CASCADE FLIPS");
    expect(r.out).toContain(":where(.a) .x (0,1,0) now loses 'color' vs");
    expect(r.out).toContain("1 cascade flip(s)");
    expect(r.out).toContain(`as Bun ${Bun.version} minifies it; a trend`);
    const github = (
      await cli(root, "diff", "base.css", "head.css", "--format", "github")
    ).out;
    expect(
      github.startsWith(
        "::error file=head.css,line=1,col=1,title=crassus%3A cascade flip (heuristic",
      ),
    ).toBe(true);
  });

  it("appends the human report to --summary, whatever the format", async () => {
    const root = await project({
      "base.css": BASE,
      "head.css": HEAD,
      "summary.md": "earlier step output\n",
    });
    const r = await cli(
      root,
      "diff",
      "base.css",
      "head.css",
      "--format",
      "github",
      "--summary",
      "summary.md",
    );
    expect(r.code).toBe(1);
    expect(r.out.startsWith("::error file=head.css")).toBe(true);
    const md = await read(root, "summary.md");
    expect(
      md.startsWith(
        "earlier step output\n### crassus diff against base.css\n\n```text\n",
      ),
    ).toBe(true);
    expect(md).toContain("1 cascade flip(s)");
    expect(md.endsWith("\n```\n")).toBe(true);
    // No color codes, even from a terminal.
    expect(md).not.toContain("\x1b[");
  });

  it("cuts --summary to fit GitHub's 1 MiB, with a note", async () => {
    const root = await project({});
    const file = join(root, "summary.md");
    const line = "x".repeat(99);
    await appendSummary(file, "big", Array(20_000).fill(line).join("\n"));
    const md = await read(root, "summary.md");
    expect(Buffer.byteLength(md)).toBeLessThanOrEqual(1024 * 1024);
    expect(md).toMatch(CUT_NOTE_RE);
  });

  it("does not fail on order-tie flips, which are for review", async () => {
    // Two (0,2,0) rules swap places: the tie's winner changes.
    const root = await project({
      "base.css": ".btn.x { color: red }\n.btn.y { color: blue }\n",
      "head.css": ".btn.y { color: blue }\n.btn.x { color: red }\n",
    });
    const r = await cli(root, "diff", "base.css", "head.css", "--json");
    const { results } = JSON.parse(r.out);
    expect(results[0].flips).toEqual([]);
    expect(results[0].moveFlips.length).toBe(1);
    expect(r.code).toBe(0);
    const human = await cli(root, "diff", "base.css", "head.css");
    expect(human.out).toContain("order-tie flips from moved rules");
  });

  it("builds the base from git, in a worktree, and caches it", async () => {
    const root = await project({
      "crassus.config.ts": `export default { css: "out/app.css", build: "mkdir -p out && cp src/app.css out/app.css" };`,
      "src/app.css": BASE,
    });
    await commitAll(root);
    await Bun.write(join(root, "src/app.css"), HEAD);

    // --no-cache: an identical commit made within the same second has the
    // same SHA, so an earlier run's cache would answer.
    const first = await cli(root, "diff", "--base", "HEAD", "--no-cache");
    expect(first.code).toBe(1);
    expect(first.err).toContain("built in");
    expect(first.out).toContain("1 cascade flip(s)");
    const second = await cli(root, "diff");
    expect(second.err).toContain("from cache");
    expect(second.out).toBe(first.out);
    expect(await worktrees(root)).toBe(1);

    const unknown = await cli(root, "diff", "--base", "nope");
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("unknown git ref: nope");
  }, 30_000);
});

describe("crassus dead --fix", () => {
  const SASS = Bun.resolveSync("sass-embedded", import.meta.dir);

  it("previews a patch with --dry-run, then edits CSS in place", async () => {
    const css =
      ".a {\n  color: red; /* old */\n  padding: 0;\n}\n.b { top: 1px; }\n.a {\n  color: blue;\n}\n.b { top: 2px }\n";
    const root = await project({ "x.css": css });
    const dry = await cli(root, "dead", "x.css", "--fix", "--dry-run");
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("-  color: red; /* old */");
    expect(dry.out).toContain("-.b { top: 1px; }");
    expect(dry.out).toContain(
      "would delete .a { color: red }  (color: blue wins)",
    );
    expect(await read(root, "x.css")).toBe(css);

    const r = await cli(root, "dead", "x.css", "--fix");
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "2 dead declaration(s) deleted in 1 file(s); 0 left.",
    );
    // The emptied `.b` rule goes whole; the comment goes with its line.
    expect(await read(root, "x.css")).toBe(
      ".a {\n  padding: 0;\n}\n.a {\n  color: blue;\n}\n.b { top: 2px }\n",
    );
    expect((await cli(root, "dead", "x.css")).code).toBe(0);
  });

  it("edits the source through the source map", async () => {
    const root = await project({
      "dist/a.css": MAPPED_CSS,
      "dist/a.css.map": MAP,
      "src/a.scss": MAPPED_CSS,
    });
    const r = await cli(root, "dead", "dist/a.css", "--fix", "--json");
    expect(r.code).toBe(0);
    const { fix } = JSON.parse(r.out);
    expect(fix.files).toEqual(["src/a.scss"]);
    // CSS files given on the command line can't be rebuilt.
    expect(fix.check).toBe("unverified");
    expect(await read(root, "src/a.scss")).toBe(
      ".a {\n}\n.a {\n  color: blue;\n}\n",
    );
  });

  it("leaves build output and shared mixins alone, and checks Sass edits", async () => {
    const root = await project({
      "crassus.config.ts": `import path from "node:path";
        import { compileAsync } from ${JSON.stringify(SASS)};
        export default {
          async compile(root) {
            const { css, sourceMap } = await compileAsync(path.join(root, "css/app.scss"), { style: "expanded", sourceMap: true });
            return { app: { css, map: sourceMap } };
          },
        };`,
      "css/_parts.scss": "@mixin shared { color: red; }\n",
      "css/app.scss": `@use "parts";
.a {
  padding: 1px; // overridden below
  @include parts.shared;
}
.b { @include parts.shared; }
@each $n in 1, 2 { .d-#{$n} { top: 0; } }
.a { padding: 2px; color: blue; }
.d-1 { top: 1px; }
.d-2 { top: 2px; }
`,
    });
    const r = await cli(root, "dead", "--fix");
    expect(r.code).toBe(1);
    expect(r.out).toContain("Checked: re-analyzed");
    expect(r.out).toContain(
      "its source also produces declarations that aren't dead",
    );
    expect(await read(root, "css/app.scss")).toBe(`@use "parts";
.a {
  @include parts.shared;
}
.b { @include parts.shared; }
@each $n in 1, 2 { .d-#{$n} { } }
.a { padding: 2px; color: blue; }
.d-1 { top: 1px; }
.d-2 { top: 2px; }
`);
    expect(await read(root, "css/_parts.scss")).toBe(
      "@mixin shared { color: red; }\n",
    );

    const built = await project({
      "crassus.config.ts": `export default { css: "out.css", build: "printf '.a{color:red}.a{color:blue}' > out.css" };`,
    });
    const b = await cli(built, "dead", "--fix");
    expect(b.code).toBe(1);
    expect(b.out).toContain("the config's `build` writes this file");
  }, 30_000);

  it("proves partial fixes against fixEntries too", async () => {
    // `.p { color: red }` in the partial is dead in app (overridden after
    // the import) and live in theme, which the hook only compiles on request.
    const config = (
      fixEntries: string,
      honor = true,
    ) => `import path from "node:path";
      import { compileAsync } from ${JSON.stringify(SASS)};
      export default {
        ${fixEntries}
        async compile(root, options) {
          const names = ${honor ? 'options?.entries ?? ["app"]' : '["app"]'};
          const out = {};
          for (const name of names) {
            const { css, sourceMap } = await compileAsync(path.join(root, "css", name + ".scss"), { style: "expanded", sourceMap: true });
            out[name] = { css, map: sourceMap };
          }
          return out;
        },
      };`;
    const files = {
      "css/_parts.scss": ".p {\n  color: red;\n}\n",
      "css/app.scss": '@use "parts";\n.p { color: blue; }\n',
      "css/theme.scss": '@use "parts";\n',
    };

    const unproved = await project({
      "crassus.config.ts": config(""),
      ...files,
    });
    const a = await cli(unproved, "dead", "--fix");
    expect(a.code).toBe(0);
    expect(await read(unproved, "css/_parts.scss")).toBe(".p {\n}\n");
    expect(a.err).toContain(
      "css/_parts.scss is a partial: the fix is proved for app only. If other entries import it, list them in `fixEntries`.",
    );

    const proved = await project({
      "crassus.config.ts": config('fixEntries: ["app", "theme"],'),
      ...files,
    });
    const b = await cli(proved, "dead", "--fix");
    expect(b.code).toBe(1);
    expect(b.out).toContain(
      "its source also produces declarations that aren't dead",
    );
    expect(b.err).toBe("");
    expect(await read(proved, "css/_parts.scss")).toBe(
      files["css/_parts.scss"],
    );

    const ignored = await project({
      "crassus.config.ts": config('fixEntries: ["theme"],', false),
      ...files,
    });
    const c = await cli(ignored, "dead", "--fix");
    expect(c.code).toBe(2);
    expect(c.err).toContain(
      "compile(root, { entries }) didn't return theme: compile the entries it's given",
    );
  }, 30_000);

  it("undoes a fix that changed more than the dead declarations", async () => {
    // The second compile adds a rule: the check after writing must fail.
    const root = await project({
      "src/a.css": MAPPED_CSS,
      "crassus.config.ts": `import { readFileSync } from "node:fs";
        import { join } from "node:path";
        let calls = 0;
        const map = ${JSON.stringify(MAP.replace("../src/a.scss", "src/a.css"))};
        export default {
          compile: (root) => ({
            app: {
              css: readFileSync(join(root, "src/a.css"), "utf8") + (calls++ > 0 ? ".z { top: 0 }" : ""),
              map,
            },
          }),
        };`,
    });
    const r = await cli(root, "dead", "--fix");
    expect(r.code).toBe(2);
    expect(r.err).toContain(
      "changed more than its dead declarations, so the fix was undone",
    );
    expect(await read(root, "src/a.css")).toBe(MAPPED_CSS);
  });

  it("rejects --fix with --entry, other formats or diff", async () => {
    const root = await project({ "a.css": ".a{}" });
    expect(
      (await cli(root, "dead", "a.css", "--fix", "--format", "sarif")).err,
    ).toContain("--fix reports as human or json");
    expect((await cli(root, "diff", "a.css", "a.css", "--fix")).err).toContain(
      "--fix goes with dead",
    );
    expect((await cli(root, "dead", "a.css", "--dry-run")).err).toContain(
      "--dry-run goes with --fix",
    );
  });
});

const RECOLOR_FINDING_RE = /== \w+\.\.\w+ {2}\w+ perf: recolor/;
const SEGMENT_FINDING_RE = /== \w+\.\.\w+ {2}3 commits \(perf\)/;
const SYSTEM_ERROR_RE = /^crassus: E[A-Z]+: /;
const CAPTURED_RE =
  /^crassus: captured 8 pages \(2 fixtures × 2 themes × 2 viewports\) into snap\/a in /;

describe("crassus capture, snapshot-diff and usage", () => {
  const SITE = join(import.meta.dir, "fixtures/site");
  const CONFIG = `export default {
    browser: {
      fixtures: { dir: "out", build: "mkdir -p out && cp site/* out/" },
      themes: ["white", "g100"],
      sheetMarker: ".bx--",
      viewports: [{ width: 320, height: 640 }, { width: 1280, height: 900 }],
      readySelector: "body > *",
      settleMs: 0,
    },
  };`;
  const site = async () =>
    Object.fromEntries(
      await Promise.all(
        ["button.html", "tile.html", "lib.css"].map(async (f) => [
          `site/${f}`,
          await read(SITE, f),
        ]),
      ),
    );
  const recolor = async (root: string) =>
    Bun.write(
      join(root, "site/lib.css"),
      (await read(SITE, "lib.css")).replace("color: blue", "color: purple"),
    );

  it("captures every fixture, theme and viewport, and diffs two captures", async () => {
    const root = await project({
      "crassus.config.ts": CONFIG,
      ...(await site()),
    });
    const a = await cli(root, "capture", "snap/a");
    expect(a.err).toBe("");
    expect(a.code).toBe(0);
    expect(a.out).toMatch(CAPTURED_RE);
    expect((await readdir(join(root, "snap/a"))).sort()).toEqual([
      ".crassus-capture",
      "button.g100.1280x900.json.gz",
      "button.g100.320x640.json.gz",
      "button.white.1280x900.json.gz",
      "button.white.320x640.json.gz",
      "tile.g100.1280x900.json.gz",
      "tile.g100.320x640.json.gz",
      "tile.white.1280x900.json.gz",
      "tile.white.320x640.json.gz",
    ]);
    // The theme attribute and the viewport both reached the page.
    const tile = async (file: string) => {
      const snap = await readSnapshot(join(root, "snap/a", file));
      return snap["body>div.bx--tile"];
    };
    const narrow = await tile("tile.white.320x640.json.gz");
    expect((await tile("tile.g100.320x640.json.gz")).color).toBe(
      "rgb(255, 255, 255)",
    );
    expect(narrow.color).toBe("rgb(0, 0, 0)");
    expect(narrow["padding-top"]).toBe("0px");
    expect((await tile("tile.white.1280x900.json.gz"))["padding-top"]).toBe(
      "2px",
    );

    const same = await cli(root, "snapshot-diff", "snap/a", "snap/a");
    expect(same.code).toBe(0);
    expect(same.out).toContain("8 page(s)");
    expect(same.out).toContain("No computed-style differences.");

    await recolor(root);
    const b = await cli(root, "capture", "snap/b", "--only", "button");
    expect(b.out).toContain("4 pages (1 fixture × 2 themes × 2 viewports)");
    const diff = await cli(root, "snapshot-diff", "snap/a", "snap/b");
    expect(diff.code).toBe(1);
    expect(diff.out).toContain("only in base: tile.white.320x640.json.gz");
    // One line for the change on every page it's on.
    expect(diff.out).toContain(
      "12×  color: rgb(0, 0, 255) -> rgb(128, 0, 128)",
    );
    expect(diff.out).toContain("1 distinct change(s), 12 in all, on 4 page(s)");
    const json = JSON.parse(
      (await cli(root, "snapshot-diff", "snap/a", "snap/b", "--json")).out,
    );
    expect(json).toMatchObject({
      schema: 1,
      command: "snapshot-diff",
      claim: "ground truth",
      files: 4,
    });
    expect(json.groups).toHaveLength(1);
    expect(json.onlyBase).toHaveLength(4);

    // Only the last capture's files count, not what an earlier one left.
    await cli(root, "capture", "snap/a", "--only", "button");
    expect((await readdir(join(root, "snap/a"))).length).toBe(9);
    expect(
      (await cli(root, "snapshot-diff", "snap/a", "snap/b")).out,
    ).toContain("4 page(s)");
    // Without the manifest, the capture didn't finish.
    await rm(join(root, "snap/b/.crassus-capture"));
    const partial = await cli(root, "snapshot-diff", "snap/a", "snap/b");
    expect(partial.code).toBe(2);
    expect(partial.err).toContain(
      "snap/b isn't a complete capture (no .crassus-capture)",
    );
  }, 60_000);

  it("lists properties only one side declares, without failing", async () => {
    const root = await project({
      "crassus.config.ts": CONFIG,
      ...(await site()),
    });
    const flags = ["--only", "button", "--themes", "white", "--no-states"];
    await cli(root, "capture", "snap/a", ...flags);
    // Nothing declares `top` any more; its computed value is still auto.
    await Bun.write(
      join(root, "site/lib.css"),
      (await read(SITE, "lib.css")).replace(".bx--unused {\n  top: 0;\n}", ""),
    );
    await cli(root, "capture", "snap/b", ...flags);
    const diff = await cli(root, "snapshot-diff", "snap/a", "snap/b");
    expect(diff.out).toContain("only base recorded top");
    expect(diff.out).toContain("No computed-style differences.");
    expect(diff.code).toBe(0);
  }, 60_000);

  it("compares today's fixtures under the stylesheet at a ref", async () => {
    const root = await project({
      "crassus.config.ts": CONFIG.replace(
        "browser: {",
        'css: "site/lib.css",\n    browser: {',
      ),
      ...(await site()),
    });
    await commitAll(root);
    // Head recolors the button and stops declaring `left` at all.
    await Bun.write(
      join(root, "site/lib.css"),
      (await read(SITE, "lib.css"))
        .replace("color: blue", "color: purple")
        .replace(
          ".bx--tile {\n  left: 0;\n}\nbody .bx--tile {\n  left: 1px;\n}\n",
          "",
        ),
    );
    const flags = [
      "--themes",
      "white",
      "--viewport",
      "1280x900",
      "--no-states",
    ];
    const r = await cli(root, "compare", ...flags);
    expect(r.code).toBe(1);
    expect(r.err).toContain("crassus: base HEAD (");
    expect(r.err).toContain(
      "crassus: compared 2 pages (2 fixtures × 1 theme × 1 viewport) against site/lib.css at HEAD (",
    );
    expect(r.out).toContain("2 page(s)");
    expect(r.out).toContain("1×  color: rgb(0, 0, 255) -> rgb(128, 0, 128)");
    // Both sides record what either declares: the dropped `left` is a change.
    expect(r.out).toContain("1×  left: 1px -> auto");
    expect(r.out).not.toContain("Not compared");
    // Nothing was written.
    expect(await readdir(root)).not.toContain("snap");

    // Two files, and JSON.
    await Bun.write(join(root, "a.css"), await read(SITE, "lib.css"));
    const json = JSON.parse(
      (await cli(root, "compare", "a.css", "site/lib.css", ...flags, "--json"))
        .out,
    );
    expect(json).toMatchObject({ command: "compare", files: 2 });
    expect(json.groups.map((g: { property: string }) => g.property)).toEqual([
      "color",
      "left",
    ]);
  }, 60_000);

  it("explains winners at their source and compares screenshots", async () => {
    const root = await project({
      "crassus.config.ts": `export default {
        browser: { fixtures: "site", sheetMarker: ".a", settleMs: 0 },
      };`,
      "site/lib.css": ".a { color: red; }",
      "site/a.html": `<!doctype html><html><head><link rel="stylesheet" href="lib.css"></head><body><div class="a">a</div></body></html>`,
      "dist/base.css": MAPPED_CSS,
      "dist/base.css.map": MAP,
      "dist/head.css": MAPPED_CSS.replace("blue", "green"),
      "dist/head.css.map": MAP,
    });
    const r = await cli(
      root,
      "compare",
      "dist/base.css",
      "dist/head.css",
      "--no-states",
      "--explain",
      "--visual",
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "Element screenshots: pixels differ on 1 of 1 changed element(s)",
    );
    expect(r.out).toContain(
      "1×  color: rgb(0, 0, 255) -> rgb(0, 128, 0)  pixels differ on 1 of 1",
    );
    // The second `.a {` is line 4 of the CSS, mapped to line 4 of src/a.scss.
    expect(r.out).toContain("won by .a (src/a.scss:4) on both sides");
  }, 60_000);

  it("bisects a range down to the commit that changed what users see", async () => {
    const root = await project({
      "crassus.config.ts": CONFIG.replace(
        "browser: {",
        'css: "site/lib.css",\n    browser: {',
      ),
      ...(await site()),
    });
    await commitAll(root);
    const git = (...args: string[]) =>
      $`git -c user.email=t@t -c user.name=t ${args}`.cwd(root).quiet();
    let css = await read(SITE, "lib.css");
    const commit = async (subject: string, next: string) => {
      css = next;
      await Bun.write(join(root, "site/lib.css"), css);
      await git("commit", "-q", "-am", subject, "--allow-empty");
    };
    await commit("refactor: comment", `/* lib */\n${css}`);
    await commit(
      "perf: drop the unused rule",
      css.replace(".bx--unused {\n  top: 0;\n}\n", ""),
    );
    await commit("perf: recolor", css.replace("color: blue", "color: purple"));
    await commit("perf: nothing", css);
    await commit("docs: readme", css);

    const flags = [
      "--themes",
      "white",
      "--viewport",
      "1280x900",
      "--no-states",
    ];
    const r = await cli(root, "bisect", "HEAD~5..", ...flags);
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      "crassus: bisecting 5 commit(s) in 3 segment(s) by type",
    );
    // refactor, perf ×3 (halved twice), docs.
    expect(r.out).toContain(
      "5 commit(s) in HEAD~5..HEAD, in 3 segment(s) by type",
    );
    expect(r.out).toContain("refactor: comment  no visible change");
    expect(r.out).toContain("3 commits (perf)  1 visible change(s)");
    expect(r.out).toContain("2 commits (perf)  1 visible change(s)");
    expect(r.out).toContain("perf: drop the unused rule  no visible change");
    expect(r.out).toContain("perf: nothing  CSS unchanged");
    expect(r.out).toContain("perf: recolor  1 visible change(s)");
    expect(r.out).toContain("docs: readme  CSS unchanged");
    expect(r.out).toMatch(RECOLOR_FINDING_RE);
    expect(r.out).toContain("1×  color: rgb(0, 0, 255) -> rgb(128, 0, 128)");

    const json = JSON.parse(
      (
        await cli(
          root,
          "bisect",
          "HEAD~5..HEAD",
          ...flags,
          "--group-by",
          "commit",
          "--json",
        )
      ).out,
    );
    expect(json).toMatchObject({
      command: "bisect",
      groupBy: "commit",
      commits: 5,
    });
    expect(
      found(json.segments).map((s: BisectResult) => s.commits[0].subject),
    ).toEqual(["perf: recolor"]);
    // Without splitting, the segment is the finding.
    const whole = await cli(root, "bisect", "HEAD~5..", ...flags, "--no-split");
    expect(whole.out).toMatch(SEGMENT_FINDING_RE);
  }, 120_000);

  it("captures with another stylesheet swapped in with --css", async () => {
    const root = await project({
      "crassus.config.ts": CONFIG,
      ...(await site()),
      "other.css": ".bx--btn { color: rgb(1, 2, 3); }",
    });
    const flags = ["--only", "button", "--themes", "white", "--no-states"];
    const r = await cli(
      root,
      "capture",
      "snap/x",
      "--css",
      "other.css",
      ...flags,
    );
    expect(r.out).toContain("with other.css into snap/x");
    const snap = await readSnapshot(
      join(root, "snap/x/button.white.1280x900.json.gz"),
    );
    expect(snap["body>div.bx--wrap>button.bx--btn"].color).toBe("rgb(1, 2, 3)");
  }, 60_000);

  it("prints a system error in one line", async () => {
    const root = await project({
      "crassus.config.ts": `export default { browser: { fixtures: "site" } };`,
      ...(await site()),
    });
    const r = await cli(root, "capture", "site/lib.css/out");
    expect(r.code).toBe(2);
    expect(r.err).toMatch(SYSTEM_ERROR_RE);
    expect(r.err.split("\n")).toHaveLength(1);
  });

  it("captures a git ref's fixtures in a worktree with --base", async () => {
    const root = await project({
      "crassus.config.ts": CONFIG,
      ...(await site()),
    });
    await commitAll(root);
    await recolor(root);

    const flags = [
      "--only",
      "button",
      "--themes",
      "white",
      "--viewport",
      "1280x900",
    ];
    const base = await cli(
      root,
      "capture",
      "--base",
      "HEAD",
      "snap/base",
      ...flags,
    );
    expect(base.code).toBe(0);
    expect(base.out).toContain(
      "1 page (1 fixture × 1 theme × 1 viewport) at HEAD (",
    );
    await cli(root, "capture", "snap/head", ...flags);
    const diff = await cli(root, "snapshot-diff", "snap/base", "snap/head");
    expect(diff.code).toBe(1);
    // The button, and its forced :focus and :active (:hover stays green).
    expect(diff.out).toContain("3×  color: rgb(0, 0, 255) -> rgb(128, 0, 128)");
    expect(await worktrees(root)).toBe(1);
  }, 60_000);

  it("writes usage.json and report.md, and exits 0", async () => {
    const root = await project({
      "crassus.config.ts": CONFIG,
      ...(await site()),
    });
    const r = await cli(root, "usage", "--matcher", "cdp");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("crassus: usage over 8 pages");
    expect(r.out).toContain(
      ".crassus/usage/usage.json, .crassus/usage/report.md",
    );
    const usage: UsageFile = JSON.parse(
      await read(root, ".crassus/usage/usage.json"),
    );
    expect(usage.dead).toBe(usage.deadInFixtures.length);
    expect(usage.fold).toBe(usage.foldCandidates.length);
    // `.bx--btn { color: red }` loses to two rules; `.bx--tile { left: 0 }`
    // always to one.
    expect(usage.deadInFixtures).toEqual([
      expect.objectContaining({
        selector: ".bx--btn",
        value: "red",
        lostTo: { ".bx--wrap .bx--btn": 12, ".bx--btn:hover": 4 },
      }),
      expect.objectContaining({ selector: ".bx--tile", property: "left" }),
    ]);
    expect(usage.foldCandidates).toEqual([
      expect.objectContaining({
        selector: ".bx--tile",
        property: "left",
        lostTo: { "body .bx--tile": 4 },
      }),
    ]);
    // Both viewports count: the min-width rule matched at 1280.
    expect(usage.unmatched.map((u) => u.selector)).toEqual([".bx--unused"]);
    const report = await read(root, ".crassus/usage/report.md");
    expect(report).toContain("**Evidence, not proof**");
    expect(report).toContain("viewport(s) 320x640, 1280x900");
    expect(report).toContain("## Dead in fixtures (2)");
    expect(report).toContain(
      "| 10 | `color: red` | `.bx--btn` | 16 | `.bx--wrap .bx--btn` ×12, `.bx--btn:hover` ×4 |",
    );
    expect(report).toContain("## Fold candidates (1)");
    expect(report).toContain(
      "| 7 | `left: 0` | `.bx--tile` | `body .bx--tile` |",
    );
    expect(report).toContain("## Never matched (1)");
    expect(report).toContain("| 6 | `.bx--unused` |  |");
  }, 60_000);

  it.each([
    [["capture", "out"], "{}", "add `browser: { fixtures }`"],
    [["usage"], `{ browser: { fixtures: "site" } }`, "browser.sheetMarker"],
    [
      ["capture", "o", "--viewport", "wide"],
      `{ browser: { fixtures: "site" } }`,
      "--viewport takes WxH",
    ],
    [
      ["capture", "o", "--only", "nope"],
      `{ browser: { fixtures: "site" } }`,
      "no .html fixtures in site matching nope",
    ],
    [
      ["capture"],
      `{ browser: { fixtures: "site" } }`,
      "capture takes one output directory",
    ],
    [["snapshot-diff", "a"], "{}", "two directories"],
    [
      ["compare"],
      `{ browser: { fixtures: "site" } }`,
      "compare needs `browser.sheetMarker`",
    ],
    [
      ["compare", "--url", "http://x"],
      `{ browser: { fixtures: "site", sheetMarker: ".bx--" } }`,
      "drop --url",
    ],
    [
      ["compare", "a.css"],
      `{ browser: { fixtures: "site", sheetMarker: ".bx--" } }`,
      "compare takes two CSS files",
    ],
    [
      ["compare"],
      `{ css: { a: "site/lib.css", b: "site/lib.css" }, browser: { fixtures: "site", sheetMarker: ".bx--" } }`,
      "pick the stylesheet the fixtures load with --entry (a, b)",
    ],
    [
      ["capture", "o", "--css", "site/lib.css", "--base", "HEAD"],
      `{ browser: { fixtures: "site", sheetMarker: ".bx--" } }`,
      "pick one",
    ],
    [["dead", "--css", "x.css"], "{}", "--css goes with capture"],
    [
      ["bisect", "main"],
      `{ browser: { fixtures: "site", sheetMarker: ".bx--" } }`,
      "bisect takes one range",
    ],
    [
      ["bisect", "a..b", "--group-by", "day"],
      `{ browser: { fixtures: "site", sheetMarker: ".bx--" } }`,
      "--group-by takes type or commit",
    ],
    [
      ["compare", "--no-split"],
      "{}",
      "--group-by and --no-split go with bisect",
    ],
    [["snapshot-diff", "a", "b", "--explain"], "{}", "use crassus compare"],
    [
      ["capture", "o", "--visual"],
      "{}",
      "--explain and --visual go with compare",
    ],
    [
      ["compare", "a.css", "b.css", "--engine", "webkit", "--visual"],
      `{ browser: { fixtures: "site", sheetMarker: ".bx--" } }`,
      "need --engine chrome",
    ],
  ])("%j exits 2", async (argv, config, message) => {
    const root = await project({
      "crassus.config.ts": `export default ${config};`,
      ...(await site()),
    });
    const r = await cli(root, ...argv);
    expect(r.code).toBe(2);
    expect(r.err).toContain(message);
  });
});

describe("bisect segments", () => {
  const c = (sha: string, type: string) => ({
    sha,
    subject: `${type}: x`,
    type,
  });
  const commits = [
    c("a", "perf"),
    c("b", "perf"),
    c("c", "fix"),
    c("d", "perf"),
  ];

  it("groups consecutive commits of one type, or each commit", () => {
    expect(
      segments("0", commits, "type").map((s) => [
        s.from,
        s.to,
        s.commits.length,
      ]),
    ).toEqual([
      ["0", "b", 2],
      ["b", "c", 1],
      ["c", "d", 1],
    ]);
    expect(segments("0", commits, "commit")).toHaveLength(4);
  });

  it("finds the narrowest results with visible changes", () => {
    const diff = (visible: boolean) => ({
      files: 1,
      entries: 1,
      onlyBase: [],
      onlyHead: [],
      pages: [],
      uncompared: { onlyBase: [], onlyHead: [] },
      groups: visible
        ? [
            {
              property: "color",
              before: "a",
              after: "b",
              count: 1,
              pages: [],
              examples: [],
            },
          ]
        : [],
    });
    const r = (
      name: string,
      visible: boolean,
      parts?: BisectResult[],
    ): BisectResult => ({
      from: name,
      to: name,
      commits: [],
      css: "changed",
      diff: diff(visible),
      ...(parts && { parts }),
    });
    expect(
      found([
        r("a", true, [r("a1", false), r("a2", true)]),
        r("b", false),
        // Halves that cancel out: the segment itself is the finding.
        r("c", true, [r("c1", false), r("c2", false)]),
      ]).map((x) => x.from),
    ).toEqual(["a2", "c"]);
  });
});
