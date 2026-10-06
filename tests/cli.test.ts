import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { main } from "../src/cli/main";

// The CLI in-process, against throwaway projects.
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
    const github = (
      await cli(root, "diff", "base.css", "head.css", "--format", "github")
    ).out;
    expect(
      github.startsWith(
        "::error file=head.css,line=1,col=1,title=crassus%3A cascade flip (heuristic",
      ),
    ).toBe(true);
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
    const git = (...args: string[]) =>
      $`git -c user.email=t@t -c user.name=t ${args}`.cwd(root).quiet();
    await git("init", "-q");
    await git("add", ".");
    await git("commit", "-q", "-m", "base");
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
    // The worktree is gone.
    expect(
      (await $`git worktree list`.cwd(root).text()).trim().split("\n").length,
    ).toBe(1);

    const unknown = await cli(root, "diff", "--base", "nope");
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("unknown git ref: nope");
  }, 30_000);
});

describe("crassus dead --fix", () => {
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
    expect(await Bun.file(join(root, "x.css")).text()).toBe(css);

    const r = await cli(root, "dead", "x.css", "--fix");
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "2 dead declaration(s) deleted in 1 file(s); 0 left.",
    );
    // The emptied `.b` rule goes whole; the comment goes with its line.
    expect(await Bun.file(join(root, "x.css")).text()).toBe(
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
    expect(await Bun.file(join(root, "src/a.scss")).text()).toBe(
      ".a {\n}\n.a {\n  color: blue;\n}\n",
    );
  });

  it("leaves build output and shared mixins alone, and checks Sass edits", async () => {
    const sass = Bun.resolveSync("sass-embedded", import.meta.dir);
    const root = await project({
      "crassus.config.ts": `import path from "node:path";
        import { compileAsync } from ${JSON.stringify(sass)};
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
    expect(
      await Bun.file(join(root, "css/app.scss")).text(),
    ).toBe(`@use "parts";
.a {
  @include parts.shared;
}
.b { @include parts.shared; }
@each $n in 1, 2 { .d-#{$n} { } }
.a { padding: 2px; color: blue; }
.d-1 { top: 1px; }
.d-2 { top: 2px; }
`);
    expect(await Bun.file(join(root, "css/_parts.scss")).text()).toBe(
      "@mixin shared { color: red; }\n",
    );

    const built = await project({
      "crassus.config.ts": `export default { css: "out.css", build: "printf '.a{color:red}.a{color:blue}' > out.css" };`,
    });
    const b = await cli(built, "dead", "--fix");
    expect(b.code).toBe(1);
    expect(b.out).toContain("the config's `build` writes this file");
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
    expect(await Bun.file(join(root, "src/a.css")).text()).toBe(MAPPED_CSS);
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
