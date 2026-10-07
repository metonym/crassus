# Migrating from css-tree-based cascade tools

For projects that check their CSS with scripts of their own built on [css-tree](https://github.com/csstree/csstree) and Playwright: dead-declaration and cascade-diff checks, a computed-style snapshot, a usage report. carbon-components-svelte moved this way. Its commits are the worked example.

## Map each script to a rung

| Your script does | crassus | Claim |
|:---|:---|:---|
| Declarations a later identical selector always overrides | `crassus dead` (`--fix` to delete them in the sources) | proof |
| Specificity and winner changes between two builds | `crassus diff --base <ref>` | heuristic |
| Declarations that match on fixture pages but never win | `crassus usage` | evidence |
| Computed styles per element, theme and forced state, before and after | `crassus capture` and `crassus snapshot-diff` | ground truth |
| Selector matching cost | Nothing: keep your harness | (not a cascade claim) |

Put the stylesheets in `crassus.config.ts`. Use `css` and `build` for files your build writes, or a `compile(root)` hook that returns CSS and source maps, so findings land on the `.scss` line. Add a `browser` block for the fixture pages (see the README's "Fixture pages"). Then delete the scripts and their tests: crassus's test suite covers the behaviour.

## Differences to expect

- **Values keep their source spacing.** css-tree regenerates values; crassus reports the text as written. `calc(-1*var(--x))` stays `calc(-1*var(--x))`, and a minified sheet's `scale(1)rotate(-45deg)` stays unspaced. Tests that compare value strings may need their expectation updated. Byte counts of minified sheets differ by the spacing.
- **Selectors and conditions have one spelling.** `Rule.selector` and `Rule.context` are canonical, whatever the source's whitespace (`a>b`, `@media (width>=1px)and (min-height:1px)`).
- **Paths are relative to the project**, not absolute.
- **Some specificity is spec-correct where css-tree tools weren't**: one-colon pseudo-elements (`.a:after` is `(0,1,1)`), `:nth-child(An+B of S)` and `:host(X)`. A diff against your old output can show these.

## If you keep a browser driver of your own

`crassus usage` and `crassus capture` replace a Playwright driver. If you keep one anyway (for a harness crassus doesn't cover), use these to key its output to `parseRules` without a second CSS parser:

- **`canonicalSelector(text)`** spells CDP's `selectorList.selectors[i].text` as `Rule.selector` does.
- **`canonicalContext(name, prelude)`** spells CDP's `media[].text`, `supports[].text` and `containerQueries[].conditionText` (as `canonicalContext("media", text)`) as one segment of `Rule.context`. Segments join with ` / `, outermost first.
- **`SHORTHANDS[name]`** lists the longhands a shorthand sets, spelled as CDP lists them. When CDP matches a shorthand without `longhandProperties` (`padding: var(--a) 2px`), expand it with `SHORTHANDS[name]?.includes(longhand)`. This covers logical shorthands too: `margin-block` sets `margin-block-start` and `margin-block-end`, not `margin-top`.

## CI

`--base <ref>` builds the base in a temporary `git worktree` of the whole repository, running your `build` command or `compile` hook there with your installed `node_modules` linked in. The result is cached by commit under `node_modules/.cache/crassus`. Fetch the base ref first: with `actions/checkout`, use `fetch-depth: 0`. A single run can annotate the PR and fill the job summary:

```yaml
- run: bunx crassus diff --base "origin/$BASE_REF" --format github --summary "$GITHUB_STEP_SUMMARY"
  env:
    BASE_REF: ${{ github.base_ref }}
```

Cascade flips over-report by design. If the job shouldn't block a merge, set `continue-on-error: true`.

## Fixture builds

`browser.fixtures.build` runs in the project root, but the tool it runs may resolve paths from somewhere else. A Vite config with `root: "e2e/fixtures"` reads `--outDir` relative to that root, so write `--outDir ../../.crassus/fixtures` (or an absolute path) to land in `.crassus/fixtures`. Add `.crassus/` to `.gitignore`.
