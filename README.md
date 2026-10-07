# crassus

> Zero-dependency CSS cascade regression testing. Prove which declarations are dead, catch cascade flips between builds, and check what real browsers resolve.

The library runs anywhere JavaScript does: Bun, Node, Deno, browsers and workers. The CLI and `crassus/browser` need Bun.

CSS refactors are risky because the cascade is global and order-dependent: a regression throws nothing, a button is just the wrong color in one theme on hover. crassus treats **the resolved cascade as the thing under test**, at increasing cost and certainty:

| Rung | Check | Cost | Claim |
|:---|:---|:---|:---|
| 0 | `deadDeclarations` | ms, no browser | **proof**: a later rule with the same selectors always wins |
| 1 | `cascadeDiff` | ~100 ms, no browser | **heuristic**: winner relationships that flipped between two builds (over-reports by design) |
| 2 | `runUsage` | seconds, real browser | **evidence**: declarations that match but never win, bounded by your fixture pages |
| 3 | `capture` | seconds, real browser | **ground truth**: computed styles per element, theme and forced state |

Every rung says how far its findings can be trusted, and cheaper rungs point at the ones that can confirm them.

```sh
bun i -d crassus
bunx crassus dead dist/styles.css      # rung 0: declarations that can never win
bunx crassus diff --base main          # rung 1: cascade flips since main
```

Or as a library:

```ts
import { cascadeDiff, deadDeclarations, parseRules } from "crassus";

// Rung 0: declarations that can never win.
for (const d of deadDeclarations(css, true)) {
  console.log(`${d.selector} { ${d.property}: ${d.value} } <- ${d.by.property}`);
}

// Rung 1: cascade flips between a base and a head build.
const diff = cascadeDiff(parseRules(baseCss, true), parseRules(headCss, true));
for (const f of diff.flips) {
  console.log(`${f.rule.selector} now ${f.after} '${f.prop}' vs ${f.other.selector}`);
}
```

## CLI

The `crassus` bin runs on Bun.

```sh
crassus dead [file.css...]        # declarations that can never win (proof)
crassus dead --fix [--dry-run]    # delete them, in the CSS or in its sources
crassus diff [--base <ref>]       # cascade flips since a git ref (heuristic)
crassus diff base.css head.css    # or between two files

crassus capture <dir>             # computed styles of every fixture page (rung 3)
crassus capture --base main <dir> # the same at a git ref, in a worktree
crassus snapshot-diff <base> <head>  # compare two captures (ground truth)
crassus usage                     # declarations that match but never win (rung 2, evidence)
```

| Option | Description |
|:---|:---|
| `--base <ref>` | Git ref to diff against (default `HEAD`). The base is built in a temporary `git worktree` with your own build, and cached by commit under `node_modules/.cache/crassus`. |
| `--entry <name>` | Only this stylesheet (repeatable). |
| `--format <format>` | `human` (default), `json` (stable schema), `github` (workflow annotations at the source line) or `sarif` (code scanning). `--json` is short for `--format json`. |
| `--config <file>` | Config file (default `crassus.config.{ts,js,mjs}`). |
| `--fix` | `dead`: delete the dead declarations. See [Fixing](#fixing). |
| `--dry-run` | With `--fix`: print the edits as a unified diff and write nothing. |
| `--no-cache` | Rebuild the base. |
| `--verbose` | List every rule in review sections. |

`capture` and `usage` load the fixture pages from the config's [`browser`](#fixture-pages) block, and take:

| Option | Description |
|:---|:---|
| `--base <ref>` | `capture`: build and capture the fixtures of a git ref, in a temporary worktree. |
| `--only <text>` | Only fixtures whose name contains this. |
| `--themes <a,b>` | Themes to load each page in. |
| `--viewport <WxH>` | Viewport (repeatable), as `320x640`. |
| `--no-states` | Skip forced `:hover`/`:focus`/`:active` states. |
| `--engine <name>` | `chrome` (default) or `webkit`. |
| `--matcher <name>` | `usage`: `dom` (default, any engine) or `cdp` (Chrome, exact per element). |
| `--concurrency <n>` | Tabs in parallel (default 8). |
| `--url <base>` | Use a running server instead of building and serving the fixtures. |
| `--out <dir>` | `usage`: output directory (default `.crassus/usage`). |

Exit codes: `0` clean, `1` findings (dead declarations, cascade flips; for `snapshot-diff`, any difference; for `capture`, a page that never matched `readySelector`), `2` usage or build error. Review sections, like order-tie flips from moved rules, never fail a run, and `usage` always exits `0`: its findings are evidence, bounded by the fixtures.

Findings point at the authoring source (`css/_button.scss:42`) when the stylesheet has a source map: a sibling `.map`, a `sourceMappingURL` comment, or the map a `compile` hook returns. Without one they point at the CSS.

`capture` writes one JSON file per page (`<fixture>.<theme>.json`, or `<fixture>.<theme>.<W>x<H>.json` with several viewports). `snapshot-diff` compares two such directories: pages on one side only and elements on one side only (DOM or state changes) are listed, and computed-style changes are grouped by `property: before -> after`, so a systematic change reads as one line with its pages and example elements. `--format json` gives the full diff.

`usage` writes `usage.json` (every matched declaration with its counts, never-matched rules, dead declarations and fold candidates) and `report.md`: declarations that matched and never won, with what they lost to, by size (losses only to `prefers-reduced-motion`, `prefers-contrast` or `forced-colors` rules are left out, as alternatives for a user preference); fold candidates, which always lose to the same single rule; and rules that never matched. All of it is bounded by the fixtures, themes, viewports and states the run covered.

`diff` prints what changed between the two builds: the specificity profile, the files carrying the most selectors at three or more classes, the minified size as Bun minifies it (a trend, not a budget), dropped, new, rewritten and moved rules, and two sections of flips: **cascade flips**, where the winner between two rules that may match one element changed (these fail), and **order-tie flips** from rules that only moved (review). Both are rung 1 heuristics: confirm them with a computed-style snapshot (rung 3).

The size line is Bun's minifier (the version is printed) with no browser targets, so it tracks the direction of a change, not what you ship. If you minify with something else or for specific targets, keep your size budget on your own build output.

### Fixing

`crassus dead --fix` deletes declarations that can never win, where it can prove the edit removes nothing else:

- **CSS without a source map** is edited in place. A rule left empty goes too, and so does a comment that ends the declaration's line. Stylesheets the config's `build` writes are output, so they're left alone.
- **With a source map**, the declaration is deleted in its source (`.scss`, `.less`, `.css`) when every declaration that source line produces, in every stylesheet analyzed, is dead. A mixin or loop line that also produces a live declaration stays, and so do sources outside the project or under `node_modules`. Run it without `--entry`, and configure every entry that shares the sources: the proof only covers the stylesheets crassus compiles. If your `compile` hook builds only some entries by default, list the rest in `fixEntries`: `--fix` asks the hook for them with `compile(root, { entries })`. When it deletes from a partial (`_*.scss`) without `fixEntries`, it says which entries the proof covered.
- **Every fix is checked.** crassus rebuilds the stylesheets, and they must have lost exactly the fixed declarations; otherwise it restores the files and exits 2. CSS files given on the command line with a source map can't be rebuilt: crassus says so, and you rebuild and run it again.

Each fixed line names the value that wins instead. A dead declaration never wins, but the winner isn't always the value you meant, so review the diff (`--dry-run` shows it first). The exit code is 0 when everything was fixed and 1 when something was left.

### Configuration

`crassus.config.ts` at the project root (Bun loads TypeScript natively):

```ts
import { defineConfig } from "crassus";

export default defineConfig({
  // Built CSS: one file, several, or by name. Source maps are read next to them.
  css: { app: "dist/app.css" },
  // Writes `css`. Also runs in the temporary checkout of the base for `diff`.
  build: "bun run build:css",
});
```

To compile in-process instead, return the CSS and its source map from `compile(root)`, where `root` is the project or the base checkout. carbon-components-svelte compiles its Sass this way, so findings land on the `.scss` line:

```ts
import path from "node:path";
import { initAsyncCompiler } from "sass-embedded";
import { defineConfig, type Stylesheets } from "crassus";

export default defineConfig({
  async compile(root) {
    const compiler = await initAsyncCompiler();
    try {
      const compile = async (name: string) => {
        const { css, sourceMap } = await compiler.compileAsync(
          path.join(root, "css", `${name}.scss`),
          {
            style: "expanded",
            sourceMap: true,
            loadPaths: [path.join(root, "css/vendor")],
            quietDeps: true,
          },
        );
        return [name, { css, map: sourceMap }] as const;
      };
      return Object.fromEntries(
        await Promise.all(["all", "white"].map(compile)),
      ) as Stylesheets;
    } finally {
      await compiler.dispose();
    }
  },
  // `bx--slider__thumb--lower` -> `slider`: order-tie flips only pair rules
  // of the same component. This is the default.
  componentOf: (cls) => cls.replace(/^[a-z]+--/, "").split(/__|--/)[0],
});
```

| Option | Description |
|:---|:---|
| `css` | Built CSS files, relative to the project root: a path, an array, or `{ name: path }`. |
| `build` | Shell command that writes `css`. Runs before reading, in the project and in the base checkout. |
| `compile(root, { entries? })` | Instead of `css` and `build`: returns `{ name: { css, map? } }`. With `entries`, compiles those. |
| `fixEntries` | `dead --fix`: more entries to prove fixes against (a theme that imports the same partials), compiled with `compile(root, { entries })`. |
| `componentOf(class)` | The component a class belongs to, to scope order-tie flips. |

#### Fixture pages

`capture` and `usage` load every `.html` file in a fixture directory, once per theme and viewport, in Chrome or WebKit through [`Bun.WebView`](https://bun.sh/docs/runtime/webview):

```ts
export default defineConfig({
  browser: {
    // A directory of .html pages, and optionally the command that writes it
    // (it runs in the base worktree too, for `capture --base`).
    fixtures: { build: "bun run build:fixtures", dir: ".crassus/fixtures" },
    themes: ["white", "g100"], // set on <html theme="…"> before first paint
    sheetMarker: ".bx--", // usage: text only the library stylesheet contains
    viewports: [
      { width: 320, height: 640 },
      { width: 1280, height: 900 },
    ],
    readySelector: "#app > *", // wait for the page to mount
  },
});
```

| Option | Description |
|:---|:---|
| `fixtures` | The fixture directory, or `{ dir, build? }`. |
| `themes` | Themes to load each page in (default: one run, no attribute). |
| `themeAttribute` | The `<html>` attribute a theme is set as (default `theme`). |
| `sheetMarker` | Text only the library stylesheet contains; `usage` needs it to tell that sheet from the page's others. |
| `viewports` | `{ width, height }[]` (default 1280 × 900). Cover your breakpoints: at one width, rules for the others read as never matched. |
| `readySelector`, `readyTimeoutMs` | Wait after load until the selector matches (up to 5 s by default). Pages that never match are reported. |
| `settleMs` | `capture`: wait after load (default 500). |
| `engine`, `concurrency`, `chromePath` | Defaults for `--engine` and `--concurrency`, and the Chrome binary. |

In GitHub Actions, `--format github` puts each finding on the PR diff at its source line:

```yaml
- run: bunx crassus diff --base origin/${{ github.base_ref }} --format github
```

## API

### `crassus`

| Export | Description |
|:---|:---|
| `parseRules(css, positions?)` | One `Rule` per selector: condition context (`@media` / `@supports` / `@container`), cascade layer and its rank, `@scope`, canonical selector, specificity, subject, declarations, source order, and with `positions` the line and column. |
| `canonicalSelector(text)`, `canonicalContext(name, prelude)` | A selector, or one `@name prelude`, spelled as `Rule.selector` and `Rule.context` spell it, whatever the source's spacing. Keys a browser's matched rules (CDP's selector, media, supports and container text) to `parseRules`. |
| `SHORTHANDS` | Shorthand (or legacy alias) → the longhands it sets, generated from Chrome's CSSOM: 119 shorthands, including logical, grid and experimental ones. Longhands are spelled as CDP lists them beside a matched shorthand (`margin-block` sets `margin-block-start` and `margin-block-end`), so a usage driver of its own can expand a shorthand CDP sends without `longhandProperties`. |
| `deadDeclarations(css, positions?)` | Declarations that can never win: every selector of the rule is repeated, in the same context and scope, by a rule later in the cascade (importance, then layer, then source order) setting the same property or a covering shorthand (logical/physical twins included). Fallbacks, vendor prefixes and legacy aliases (`grid-gap` before `gap`) aren't reported. |
| `cascadeDiff(base, head, { componentOf? })` | Between two builds' rules: removed, added, rewritten (same declarations, new selector), dropped and new rules, context and layer moves, moved rules, and **cascade flips**, where the winner between two rules that may match one element changed. `moveFlips` are the order ties of rules that only moved. |
| `defineConfig(config)` | Types a `crassus.config.ts`. |

Types: `Rule`, `DeadDeclaration`, `CascadeDiff`, `Flip`, `Config`, `BrowserConfig`, `Stylesheets`.

### `crassus/browser` (Bun)

Real-browser rungs on [`Bun.WebView`](https://bun.sh/docs/runtime/webview): Chrome or Chromium over CDP (auto-detected, including Playwright's cached `chrome-headless-shell`), or the system WebKit on macOS. No Playwright and no browser download.

| Export | Description |
|:---|:---|
| `capture(options)` | Computed-style snapshot of every element, `::before`/`::after` and forced `:hover`/`:focus`/`:active`, per theme and viewport, one JSON file per page. States come from CDP (exact) or from rewriting state selectors in place (any engine). |
| `diffSnapshots(baseDir, headDir, { examples? })` | Compares two `capture` directories: changed element paths per page, and every change grouped by `(property, before -> after)` with counts and example paths. Pages and paths on one side only are listed, not diffed. |
| `runUsage(options)` | Which declarations of the library stylesheet (the one containing `sheetMarker`) match and win on every element, over all themes and viewports. `matcher: "cdp"` asks Chrome per element; `matcher: "dom"` matches in the page with `Element.matches()` in one round trip per page, on Chrome or WebKit. |
| `serveFixtures(dir)` | Static fixture server that sets a theme attribute before first paint. |

Both browser runs take:

- `viewports: { width, height }[]`: every page at each size (default one, 1280 × 900; `width`/`height` still set a single one). Use enough to cover the stylesheet's `min-width`/`max-width` breakpoints, or rules outside them read as never matched. With several, capture files are named `<name>.<theme>.<W>x<H>.json`.
- `readySelector` (and `readyTimeoutMs`, default 5000): wait after load until the selector matches, for content that mounts late. A page that never matches is still read, and returned in `notReady`.

Types: `CaptureOptions`, `UsageOptions`, `UsageFile`, `Snapshot`, `Viewport`, `SnapshotDiff`, `SnapshotPageDiff`, `SnapshotDiffOptions`, `PageDiff`, `PropertyChange`, `ChangeGroup`.

## Features

- **Zero dependencies.** The parser, selector engine and specificity are original code.
- **Accurate.** Reads the same selectors as css-tree on Carbon, Bootstrap, Bulma, Primer, Tailwind 2 and Open Props. On carbon-components-svelte's history it reproduces the original css-tree-based tools exactly: identical dead declarations, and identical cascade flips on six real refs including a 3,666-rule refactor.
- **Spec-correct where the original tools weren't.** One-colon pseudo-elements (`.a:after` is `(0,1,1)`), `:nth-child(An+B of S)` and `:host(X)` specificity, raw custom-property values.
- **Cascade layers and `@scope`.** Layers order by first declaration (including `@import … layer()`), nested layers sort before their parent's own rules, unlayered rules win, and `!important` reverses it all. Scoped rules beat unscoped ones at equal specificity. Checked against Chrome.
- **Class- and attribute-styled components.** Subjects carry their attribute constraints, so `[data-part=item]` rules pair with each other, `[data-state=open]` and `[data-state=closed]` never do, and `:not([disabled])` excludes `[disabled]`.
- **CSS nesting.** Nested rules are flattened with `&` resolved as `:is(<parent>)` (spliced in when that's equivalent), and declarations after a nested rule or inside a nested `@media` become rules of their own at that position, as browsers do.
- **Fast real-browser checks.** The `dom` usage engine resolves 218 pages in 22 s, against ~20 minutes for a Playwright + CDP driver, and expands shorthands, `var()` and vendor aliases through the engine's own CSSOM.
- **Cross-engine.** The same checks run on WebKit, so Safari-only cascade differences show up (for example, WebKit rejects unprefixed `user-select`).

## Benchmarks

Measured against carbon-components-svelte's original tooling (css-tree, source-map-js, Playwright) on Apple Silicon, same Chromium build for browser comparisons. Reproduce with `bun run bench` and the evals in `eval/carbon/`.

| Job | Before | crassus |
|:---|:---|:---|
| `parseRules`, Carbon `all.css` 638 kB | 34.5 ms | **12.7 ms** (2.7×) |
| `parseRules` + positions, Tailwind 2, 3.5 MB | 242.0 ms | **97.9 ms** (2.5×) |
| `deadDeclarations`, Primer 1 MB | 1,773 ms | **25.2 ms** (70×) |
| Source-map lookups, 6,594 rules | 16.1 ms | **2.7 ms** (6×) |
| Computed-style snapshot, 218 pages | 471.7 s | **43.9 s** (CDP, 8 tabs, identical output) |
| Cascade usage, 218 pages | 1,171.7 s | **22.3 s** (`dom` engine, 8 tabs) |

## Limitations

- **`dead` assumes the later declaration applies.** If a browser rejects its value or its selector, the earlier declaration still wins there. Known fallback patterns (vendor prefixes, `fit-content`, `dvh`, legacy aliases) aren't reported.
- **Logical properties assume a horizontal writing mode.** `inset-block-start` and `top` share a slot; the inline axis is left alone.
- **Two different `@scope` roots are compared by source order.** Which is closer depends on the DOM. A scoped rule does beat an unscoped one at equal specificity.
- **Selector performance is out of scope.** How long Chrome spends matching selectors (DevTools' selector stats, `RecalcStyleDuration`) is a measurement, not a claim about the cascade, so it has no rung. `eval/carbon/selector-stats-harness.ts` is a measurement spike kept for comparison and won't ship; keep a perf harness of your own.
