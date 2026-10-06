# Changelog

## 0.1.0 — 2026-10-06

**Features**

- `parseRules(css, positions?)` parses a stylesheet into one `Rule` per
  selector: its condition context (`@media`, `@supports`, `@container`,
  outermost first), cascade layer and rank, `@scope`, canonical selector,
  specificity, subject, declarations and source order. `positions` (default
  `false`) adds a 1-based line and 0-based column. Nested rules are flattened
  with `&` resolved as `:is(<parent>)`, spliced in when that's equivalent,
  and declarations after a nested rule or inside a nested `@media` become
  rules of their own at that position, as browsers do. Layers order by first
  declaration, including `@import … layer()`; nested layers sort before
  their parent's own rules; unlayered rules win; `!important` reverses the
  layer order. Specificity follows Selectors Level 4. `.a:after` is
  `(0,1,1)`, and `:nth-child(An+B of S)` and `:host(X)` count their
  arguments. Custom-property values stay raw. A subject carries its classes,
  attribute constraints and negations, so `[data-part=item]` rules pair with
  each other, `[data-state=open]` and `[data-state=closed]` don't, and
  `:not([disabled])` excludes `[disabled]`. The parser, selector engine and
  specificity are original code, and the package has no dependencies. It
  runs in Bun, Node, Deno, browsers and workers. `Rule` is exported.
- `deadDeclarations(css, positions?)` returns declarations that can never
  win. Every selector of the rule is repeated, in the same context and
  scope, by a rule later in the cascade (importance, then layer, then source
  order) that sets the same property or a shorthand covering it. Logical and
  physical twins share a slot in a horizontal writing mode, so
  `inset-block-start` and `top` do; the inline axis is left alone, because
  it depends on `dir`. Fallbacks, vendor prefixes and legacy aliases
  (`grid-gap` before `gap`, `fit-content`, `dvh`) aren't reported, and
  layers whose order depends on a condition aren't compared. It assumes the
  later declaration applies: if a browser rejects its value or its selector,
  the earlier one still wins there. Each `DeadDeclaration` names the winner
  (`by`), the offsets of the declaration (`span`), and with `positions` its
  line and column. `DeadDeclaration` is exported.
- `cascadeDiff(base, head, { componentOf? })` compares two builds' rules.
  `removed`, `added`, `rewrites` (the same declarations under a new
  selector), `dropped`, `newRules`, `contextMoves` and `movedHead` say what
  changed. `flips` are winner relationships that changed between two rules
  that may match one element. The winner follows importance, then layer
  (reversed for `!important`), then specificity, then scope proximity, then
  source order. A scoped rule beats an unscoped one at equal specificity.
  Two different `@scope` roots are compared by source order, since which is
  closer depends on the DOM. The flip list is a heuristic, and it
  over-reports by design: a computed-style snapshot is what confirms one.
  `moveFlips` are the equal-specificity ties of rules that only moved, and
  only rules of one component are paired. `componentOf` defaults to stripping
  a leading `prefix--` and cutting at the first `__` or `--`
  (`bx--slider__thumb--lower` gives `slider`). `CascadeDiff` and `Flip` are
  exported.
- `defineConfig(config)` types a `crassus.config.ts`. `css` is the built
  stylesheets: a path, an array, or `{ name: path }`. `build` is a shell
  command that writes them, and it also runs in the temporary checkout of
  the base for `diff`. `compile(root)` returns `{ name: { css, map? } }`
  instead of `css` and `build`. `root` is the project, or that checkout.
  `componentOf` is the same function `cascadeDiff` takes. `Config` and
  `Stylesheets` are exported.
- The `crassus` bin runs on Bun. `crassus dead [file.css...]` prints
  declarations that can never win. `crassus diff [--base <ref>]` prints
  cascade flips since a git ref (default `HEAD`). The base is built in a
  temporary `git worktree` with the project's own `build` or `compile`, and
  cached by commit under `node_modules/.cache/crassus`. `crassus diff
  base.css head.css` compares two files. `--entry <name>` keeps one
  stylesheet, and can be repeated. `--format` is `human` (default), `json`
  (schema `1`), `github` (a workflow annotation at the source line) or
  `sarif`. `--json` is `--format json`. `--config` selects the config
  (default `crassus.config.{ts,js,mjs}`). `--no-cache` rebuilds the base.
  `--verbose` lists every rule in the review sections. A finding points at
  the authoring source when the stylesheet has a source map: a sibling
  `.map`, a `sourceMappingURL` comment, or the map `compile` returns.
  Without one it points at the CSS. `diff` also prints the specificity
  profile, the files carrying the most selectors at three or more classes,
  the minified size as Bun minifies it, and the dropped, new, rewritten and
  moved rules. Cascade flips fail the run. Order-tie flips are for review
  and never fail it. Exit codes: `0` clean, `1` findings, `2` a usage or
  build error.
- `crassus dead --fix` deletes declarations that can never win, where the
  edit removes nothing else. CSS without a source map is edited in place. A
  rule left empty goes too, and so does a comment that ends the
  declaration's line. Stylesheets that `build` writes are output, so they're
  left alone. With a source map, a source line is deleted when every
  declaration it produces, in every stylesheet analyzed, is dead. A mixin or
  loop line that also produces a live declaration stays, and so do sources
  outside the project or under `node_modules`. `--entry` isn't allowed: the
  proof only covers the stylesheets compiled. The command rebuilds and
  checks that the stylesheets lost exactly the fixed declarations; otherwise
  it restores the files and exits `2`. CSS given on the command line with a
  source map can't be rebuilt. `--dry-run` prints the edits as a unified
  diff and writes nothing. Each fixed line names the value that wins
  instead. The exit code is `0` when everything was fixed and `1` when
  something was left. `--fix` reports as `human` or `json`.
- `capture`, `runUsage` and `serveFixtures`, from `crassus/browser`, drive a
  real browser on Bun through `Bun.WebView`. Chrome or Chromium over CDP is
  auto-detected, including Playwright's cached `chrome-headless-shell`, and
  on macOS the system WebKit works too. There is no Playwright dependency
  and no browser download. `capture(options)` writes a computed-style
  snapshot of every element, `::before` and `::after`, per theme, and
  returns `{ pages, ms }`. Forced `:hover`, `:focus` and `:active` come from
  CDP (`states: "cdp"`) or from rewriting those selectors in place
  (`states: "rewrite"`, any engine); `false` skips them. `emulate` is
  `"cdp"` or `"cssom"`. `runUsage(options)` reports which declarations of the
  library stylesheet, the one containing `sheetMarker`, match and win, and
  writes `usage.json`. `matcher: "cdp"` asks Chrome per element.
  `matcher: "dom"` matches in the page with `Element.matches()`, one round
  trip per page, on Chrome or WebKit, and expands shorthands, `var()` and
  vendor aliases through the engine's own CSSOM. `serveFixtures(dir)` serves
  fixture pages and sets a theme attribute on `<html>` before first paint.
  `CaptureOptions`, `UsageOptions` and `Snapshot` are exported.

**Performance**

- On Apple Silicon, against the css-tree tooling this replaces:
  `parseRules` of Carbon's `all.css` (638 kB) goes from 34.5 ms to 12.7 ms,
  and `parseRules` with positions of Tailwind 2 (3.5 MB) from 242.0 ms to
  97.9 ms. `deadDeclarations` of Primer (1 MB) goes from 1,773 ms to 25.2 ms.
  Source-map lookups of 6,594 rules go from 16.1 ms to 2.7 ms. A
  computed-style snapshot of 218 pages takes 43.9 s over CDP with 8 tabs,
  against 471.7 s, with the same output. Cascade usage of those pages takes
  22.3 s with the `dom` matcher and 8 tabs, against 1,171.7 s. Selectors
  match css-tree on Carbon, Bootstrap, Bulma, Primer, Tailwind 2 and Open
  Props. On carbon-components-svelte's history the dead declarations match,
  and the cascade flips match on six real refs, including a 3,666-rule
  refactor.
