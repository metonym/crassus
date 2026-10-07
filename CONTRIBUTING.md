# Contributing

This guide covers how crassus is built, the rules every change must keep, and how to verify a change before it merges. Read it in full before changing anything under `src/`.

## Setup

[Bun](https://bun.sh/) is the package manager, test runner, bundler and (for `crassus/browser`) the runtime.

```sh
bun ci
bun run test          # unit tests, corpus parity, fuzzers, hostile inputs
bun run test:package  # build, pack, install, and use it as a consumer would
bun run typecheck
bun run lint          # biome; `bun run lint:fix` formats and applies fixes
bun run knip          # unused files, exports and dependencies
bun run build         # dist/: minified ESM, declarations, slimmed package.json
bun run gen:shorthands  # regenerate src/core/shorthands.ts from Chrome's CSSOM
```

## How it works

There are two entry points with different runtime rules.

**`crassus`** (`src/index.ts`, `src/core/`) is runtime-neutral cascade analysis over strings:

1. **Parse** (`src/core/parse.ts`). A char-code scanner recovers at-rules, style rules and declarations, respecting strings, comments, escapes, nested parens and brackets, and `{}` inside custom-property values. Values stay raw; `canonicalText` normalizes them for comparison. Positions come from a lazily built line index.
2. **Selectors** (`src/core/selector.ts`). Compounds, combinators and parts, including selector-list arguments (`:is`, `:not`, `:where`, `:has`, `:nth-child(… of S)`, `::slotted`) and one-colon legacy pseudo-elements. Selectors 4 specificity and a canonical serializer.
3. **Placement** (`src/core/placement.ts`). `placeRules` walks the parsed sheet once and gives every style rule its condition context (`@media`, `@supports`, `@container`), cascade layer (ranked by first declaration, with uncertain positions flagged) and `@scope`, and flattens CSS nesting (`&` resolved by `resolveNested` in `selector.ts`; declarations after a nested rule become rules of their own). Every walk over a stylesheet goes through it, so the rule model, `deadDeclarations` and the `dom` engine agree.
4. **Rule model** (`src/core/cascade.ts`). `parseRules` emits one `Rule` per selector with its placement, specificity, subject (the last compound's classes, attribute constraints, negations and pseudo-element) and declarations. The relation functions (`coMatchable`, `conflictingProps`, `wins`, `matchContextMoves`) are what `cascadeDiff` builds on. `wins` follows the cascade: importance, layer (reversed for `!important`), specificity, scope proximity, source order.
5. **Checks.** `deadDeclarations` (`src/core/overrides.ts`, rung 0), `cascadeDiff` (`src/core/diff.ts`, rung 1), and cascade replay plus aggregation (`src/core/usage.ts`, used by rung 2). `covers` decides whether a later property resets an earlier one from `src/core/shorthands.ts`, which `bun run gen:shorthands` generates from Chrome's CSSOM (`style.setProperty(p, "initial")`, then read back the longhands). Regenerate it rather than editing it.

**The `crassus` bin** (`src/cli/`, Bun) runs rungs 0 and 1 on a project: `main.ts` parses arguments and returns the exit code, `project.ts` loads `crassus.config.*` and the stylesheets (files, `build` + `css`, or `compile`), `baseline.ts` builds the `--base` ref in a temporary `git worktree` and caches it by commit, `sources.ts` maps compiled positions to sources through `node:module`'s `SourceMap`, `commands.ts` turns `dead` and `diff` into plain results, `fix.ts` plans, checks and applies `dead --fix` (edits must remove exactly the dead declarations, verified by re-analyzing, or they're undone), and `report.ts` formats them (human, JSON, GitHub annotations, SARIF). To try it on another project before a release, run `bun src/cli/index.ts` from that project's directory, or `bun run build` and `bun link` in `dist/`.

**`crassus/browser`** (`src/browser/`) drives real browsers through `Bun.WebView`:

- `view.ts` wraps a WebView. Each view allows one operation per slot and throws instead of queueing, so `View` serializes calls. `runPool` spreads jobs over tabs, and each tab is its own renderer process.
- `serve.ts` serves fixture pages and injects a theme attribute before first paint (WebView has no init-script API).
- `snapshot.ts` captures computed styles. Forced states use CDP (`CSS.forcePseudoState`) or an in-place `selectorText` rewrite (`:hover` → `[data-cr-hover]`, same specificity and order) that works on any engine.
- `usage-cdp.ts` asks Chrome for matched rules per element. `usage-dom.ts` plus `src/page/usage-dom.ts` match in the page instead; the pure half (aligning the CSSOM with the parsed sheet, cascade order) is `src/core/align.ts`. The page script is plain DOM code, bundled to an IIFE by a Bun macro (`page-script.ts`) and inlined at build time.

## Rules every change must keep

- **The precision ladder is the product.** Every finding states its claim strength: proof (rung 0), heuristic (rung 1), evidence (rung 2) or ground truth (rung 3). A cheaper rung must never fail on something only a more expensive rung can know; it reports it for review and names the rung that confirms it.
- **Zero runtime dependencies.** Dev-only code (`tests/`, `bench/`, `eval/`, `scripts/`) may use anything.
- **`src/core/` and `src/page/` are runtime-neutral.** No `bun`, no `node:*`, no imports from `src/browser/`. Biome enforces this (see the override in `biome.json`), and `test:package` scans `dist/index.js` and runs it under Node.
- **Original code only.** Learn other tools' behavior by running them (css-tree, Chrome's CDP, the original carbon-components-svelte scripts) and encode it as tests. Don't copy or translate their source.
- **Keep the public API small and explicit.** `src/index.ts` and `src/browser/index.ts` list every export by name (`noReExportAll`), and export only what a user needs: the rungs, the config, and the types they return. Tests import internals from `src/` directly. New options default to current behavior.

## Tests

| File | Covers |
|:---|:---|
| `tests/parser.test.ts` | Parser and selector-engine behavior, including the spec fixes over css-tree and browser error recovery |
| `tests/cascade.test.ts` | `parseRules`, specificity, subjects, layers and scopes, co-matchability, `wins`, histograms |
| `tests/diff.test.ts` | `cascadeDiff` flips, including attribute-styled subjects |
| `tests/overrides.test.ts` | `deadDeclarations` and shorthand coverage |
| `tests/align.test.ts` | CSSOM alignment, engine declaration handling and cascade order for the `dom` engine, without a browser |
| `tests/usage.test.ts` | Cascade replay, aggregation, CDP declaration handling |
| `tests/browser.test.ts` | Real Chrome: both snapshot state modes, the `cdp` and `dom` usage engines against each other (including `@layer`, `@scope` and nesting), and the Chrome fuzzer: generated sheets must give the same rules, placement and resolved selectors as Chrome's CSSOM |
| `tests/fuzz.test.ts` | The seeded fuzzer against css-tree (rule and declaration structure), and invariants on every sheet: nothing throws, positions are in range |
| `tests/fuzz-gen.ts` | The seeded stylesheet generator both fuzzers share |
| `tests/cli.test.ts` | The CLI in-process against throwaway projects: every format and exit code, config `build` and `compile`, source maps (sibling, inline), `diff --base` through a real git worktree and its cache, and `dead --fix` on CSS, mapped sources and real Sass (mixins, loops), including the undo when the check fails |
| `tests/hostile.test.ts` | Hostile inputs (`tests/hostile-inputs.ts`): deep nesting, unterminated tokens, huge lists, each parsed fast without throwing |
| `tests/corpora.test.ts` | Selector-for-selector parity with css-tree on the corpora in `bench/corpora.ts` |
| `scripts/test-package.ts` | `bun run test:package`: packs `dist/`, installs it into a scratch project, runs the core in Node, type-checks a consumer, and loads `crassus/browser` in Bun |

A behavior fix needs a test that fails before the fix and passes after.

- **Chrome is the reference for parsing.** css-tree diverges from browsers on error recovery and nesting; when they disagree, check Chrome (`new CSSStyleSheet().replaceSync(css)` in a `View`) and encode what it does as a test.
- **Run the long fuzz before merging parser changes:**

  ```sh
  for s in $(seq 1 20); do FUZZ_SEED=$s FUZZ_RUNS=20000 bun test tests/fuzz.test.ts; done
  for s in $(seq 1 10); do FUZZ_SEED=$s FUZZ_BROWSER_RUNS=2000 bun test tests/browser.test.ts -t fuzz; done
  ```

  A mismatch prints the failing stylesheet. Shrink it by hand, add a case to `tests/parser.test.ts` (or `tests/hostile-inputs.ts` for crashes and slow paths), fix, repeat.

## Evals against carbon-components-svelte

`eval/carbon/` compares crassus with the tooling it replaces in a carbon-components-svelte checkout. Point `CCS_ROOT` at a checkout that has run `bun install` and `bun run build:css`:

| Eval | Compares |
|:---|:---|
| `parity.ts` | `parseRules` and `deadDeclarations` against `scripts/lib/css-{cascade,overrides}.ts`, plus speed |
| `diff-parity.ts` | `cascadeDiff` against `check:css` on several base refs |
| `sourcemap-size.ts` | Source-map attribution and the minified-size line |
| `snapshot.ts` | `capture` against `e2e/cascade-snapshot.ts`, and WebKit against Chrome |
| `usage.ts` | `runUsage` (CDP and `dom`) against `e2e/cascade-usage.ts` |
| `selector-stats.ts` | The selector-stats harness (`selector-stats-harness.ts`) against `e2e/selector-stats.ts`. A measurement spike, not a feature: selector cost isn't a cascade claim, so it won't ship in `src/` (README, "Limitations") |

carbon-components-svelte has since moved onto crassus and deleted the tooling it replaced, so the comparisons against it need a checkout from before the migration. `96ed27f02` is the parent of the migration commit:

```sh
git -C <ccs> worktree add /tmp/ccs-pre-crassus 96ed27f02
(cd /tmp/ccs-pre-crassus && bun install && bun run build:css)
CCS_ROOT=/tmp/ccs-pre-crassus bun eval/carbon/parity.ts
```

`parity.ts` and `diff-parity.ts` exit with a message on a newer checkout. `snapshot.ts` and `usage.ts` also run on one with `--skip-old`, which compares crassus's own runs (for example across crassus versions); `sourcemap-size.ts` and `selector-stats.ts` run on either.

Output goes to `.eval/` (gitignored). Browser evals take minutes and are timing-sensitive: run them one at a time on a quiet machine.

## Performance

Changes to `src/core/` must not make things slower.

| Command | Use |
|:---|:---|
| `bun run bench:ab` | **The regression check** (`ostia ab`): `HEAD` against the working tree, alternating in one process |
| `bun run bench` | Per-corpus numbers: crassus parse vs css-tree, `parseRules`, `deadDeclarations` |

Commit first, then run `bun run bench:ab` against the commit before your change (`--base <ref>` for older refs).

## Style

- Match the surrounding code: TypeScript, biome formatting, plain-sentence comments at a similar density.
- Conventional commits: `feat`, `fix`, `perf`, `refactor`, `bench`, `test`, `docs`, `chore`, with `!` for breaking changes. Put measured numbers in the body of `perf:` commits.
- Update the README when behavior, options or benchmark numbers change.

## Before you finish

- [ ] `bun run lint`, `bun run typecheck`, `bun run knip`, `bun run test` and `bun run test:package` pass.
- [ ] `src/core/` changes: `bun run bench:ab` shows no confirmed regression.
- [ ] Changes that affect results: the relevant `eval/carbon/` eval still matches, or the difference is explained.
- [ ] The README and this guide still describe what the code does.
