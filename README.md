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
crassus diff --confirm            # only the flips Chrome shows changing a value

crassus capture <dir>             # computed styles of every fixture page (rung 3)
crassus capture --base main <dir> # the same at a git ref, in a worktree
crassus capture --css new.css <dir>  # today's fixtures with another library stylesheet
crassus snapshot-diff <base> <head>  # compare two captures (ground truth)
crassus compare --base main       # today's fixtures, library CSS at main vs now, page by page
crassus bisect main..HEAD         # which commits in a range changed what users see
crassus usage                     # declarations that match but never win (rung 2, evidence)
crassus compare --report out      # the same, as change cards: report.json, index.html, report.md
crassus explain <id>              # one card, for a person or an agent
crassus repro <id>                # a standalone page that shows it
crassus verify <id>               # whether it's fixed
crassus reduce <id>               # the fewest declaration edits that make it
crassus approve <id...>           # or record it as intended: CI stops failing on it
crassus compare --tokens cds-     # also fail where a property stops following a design token
crassus tokens --tokens cds-      # which tokens drive what; unused tokens; hard-coded colors
crassus doctor                    # check Chrome, the machine and the config before a long run
crassus coverage                  # which declarations decide a value the fixtures render
```

Browser runs open one tab (a renderer process) per `--concurrency`, by default half the cores and at most 4, in Playwright's `chrome-headless-shell` when it's installed (`bunx playwright install chromium-headless-shell`) and otherwise the Chrome Bun finds, which may be your own. Raise it on a dedicated machine, lower it beside other work. While the 1-minute load average is above the core count, every tab but one waits for it to settle, so a run beside other work slows down instead of piling on; it says so once on stderr when it starts waiting, and the summary line ends with the time spent on one tab. `loadAverage` on the visit options replaces the reader (`os.loadavg()[0]`). `crassus doctor` checks the Chrome it would use (and starts it), the tabs against the cores, the load, free disk for the project and the temp directory, the fixture pages, what `sheetMarker` finds and the tokens `browser.tokens` names, and says how to fix each problem; it exits 1 on an error.

| Option | Description |
|:---|:---|
| `--base <ref>` | Git ref to diff against (default `HEAD`). The base is built in a temporary `git worktree` with your own build, and cached by commit under `node_modules/.cache/crassus`. |
| `--entry <name>` | Only this stylesheet (repeatable). |
| `--format <format>` | `human` (default), `json` (stable schema), `github` (workflow annotations at the source line) or `sarif` (code scanning). `compare` and `bisect` take `human`, `json`, `markdown` (change cards for a PR) or `sarif` (one result per change card, at the changed rule's source line). `--json` is short for `--format json`. |
| `--config <file>` | Config file (default `crassus.config.{ts,js,mjs}`). |
| `--fix` | `dead`: delete the dead declarations. See [Fixing](#fixing). |
| `--confirm` | `diff`: render each cascade flip in Chrome and fail only on those whose value changes (needs the config's `browser` block). |
| `--dry-run` | With `--fix`: print the edits as a unified diff and write nothing. |
| `--no-cache` | Rebuild the base. |
| `--verbose` | List every rule in review sections. |
| `--summary <file>` | `dead`, `diff`, `snapshot-diff`, `compare`, `bisect`: also append the human report to this file, as a fenced block, whatever `--format` prints. Meant for `$GITHUB_STEP_SUMMARY`: it's cut at a line, with a note, to stay within GitHub's 1 MiB. |

`capture`, `compare`, `bisect` and `usage` load the fixture pages from the config's [`browser`](#fixture-pages) block, and take:

| Option | Description |
|:---|:---|
| `--base <ref>` | `capture`: build and capture the fixtures of a git ref, in a temporary worktree. `compare`: build the stylesheet at that ref (default `HEAD`). |
| `--css <file>` | `capture`: serve this CSS in place of the library stylesheet (the largest fixture `.css` file containing `sheetMarker`). |
| `--entry <name>` | `compare`: the configured stylesheet the fixtures load, when there are several. |
| `--group-by <how>` | `bisect`: segments of consecutive commits of one conventional-commit type (`type`, default) or one per commit (`commit`). |
| `--no-split` | `bisect`: report a segment with visible changes as it is, instead of halving it down to the commits that made them. |
| `--no-scope` | `compare`, `bisect`: load every page and read every element, instead of only what the changed rules can reach. |
| `--tokens <prefix>` | `compare`, `bisect`: trace design tokens (custom properties with this prefix; `cds-` for `--cds-*`, or `browser.tokens` in the config). `tokens`: the prefix to report on. |
| `--report <dir>` | `compare`, `bisect`: write change cards to this directory (with `--explain` and `--visual`). `explain`, `repro`, `verify`, `approve`: the report to read (default `.crassus/report`). |
| `--explain` | `compare`, `bisect` (Chrome): for each changed property, the declaration that won on each side, at its source through the stylesheet's source map. |
| `--visual` | `compare`, `bisect` (Chrome): screenshot every changed element on both sides, in its forced state, and count those whose pixels differ. |
| `--only <text>` | Only fixtures whose name contains this. |
| `--themes <a,b>` | Themes to load each page in. |
| `--viewport <WxH>` | Viewport (repeatable), as `320x640`. |
| `--no-states` | Skip forced `:hover`/`:focus`/`:active` states. |
| `--engine <name>` | `chrome` (default) or `webkit`. |
| `--matcher <name>` | `usage`: `dom` (default, any engine) or `cdp` (Chrome, exact per element). |
| `--concurrency <n>` | Tabs in parallel (default half the cores, at most 4). |
| `--url <base>` | Use a running server instead of building and serving the fixtures. |
| `--out <dir>` | `usage`: output directory (default `.crassus/usage`). |

Exit codes: `0` clean, `1` findings (dead declarations, cascade flips; for `snapshot-diff`, any difference; for `compare` and `bisect`, a visible change, or with `crassus.approved.json` one it doesn't approve; for `capture`, `compare` and `bisect`, a page that never matched `readySelector`, unless `browser.allowNotReady` lists its fixture), `2` usage or build error. Review sections, like order-tie flips from moved rules, never fail a run, and `usage` always exits `0`: its findings are evidence, bounded by the fixtures.

Findings point at the authoring source (`css/_button.scss:42`) when the stylesheet has a source map: a sibling `.map`, a `sourceMappingURL` comment, or the map a `compile` hook returns. Without one they point at the CSS.

`capture` writes one gzipped JSON file per page (`<fixture>.<theme>.json.gz`, or `<fixture>.<theme>.<W>x<H>.json.gz` with several viewports), storing each distinct computed style once: most elements share theirs, so a page is a few kilobytes (Carbon's data-table pages: 154 kB for 12, against 48.6 MB as plain JSON). Read one with `readSnapshot`. Once every page is written, it adds a `.crassus-capture` manifest listing them. It stops with an error before a capture would leave less than 512 MB free, projecting the pages written so far over the rest. `snapshot-diff` compares two such directories, reading only the files their manifests list, and refuses a directory without one (a capture that failed or is still running). Pages on one side only and elements on one side only (DOM or state changes) are listed, and computed-style changes are grouped by `property: before -> after`, so a systematic change reads as one line with its pages and example elements. One cause reads as one change on each element: logical twins fold into the physical property (`padding-block-start` into `padding-top`, assuming a horizontal writing mode), a full set of longhands that changed the same way into its shorthand (`border-color`, `padding-block`), and properties that follow `color` (currentColor: caret, outline, border, text-decoration colors) into `color`, each listed under `also:`. Changes no one can see on either side are listed apart as invisible, with the reason, and don't fail the run: anything under `display: none`; anything in an absolutely positioned box clipped to nothing (`clip: rect(0 0 0 0)`, `clip-path: inset(50%)`, or a 1px box with `overflow: hidden`: screen-reader-only text), or in one off the page; painted properties (colors, backgrounds, shadows) under `visibility: hidden` or `opacity: 0` (on it or an ancestor), in an in-flow box clipped that way, off the page or clipped away by an `overflow` ancestor (`capture` records those two from the box's geometry), and text drawn in the color of the background behind it; a 0 × 0 box's own background and border; the color of a border with width 0 or of an outline with style none. Each capture records only the properties its stylesheets declare, so a property only one side declares has no value on the other: it's listed under "Not compared" for review, not reported as a change, and doesn't fail the run. `--format json` gives the full diff.

`compare` answers "did this CSS change regress today's markup": it builds the library stylesheet at `--base` (default `HEAD`) and now, through the config's `css`/`build` or `compile` (or takes two CSS files), serves today's fixtures twice with each one swapped in for the stylesheet that contains `sheetMarker`, and captures both sides of every page in the same tab, diffing as it goes. It keeps no snapshots, and both sides record every property either stylesheet declares, so nothing is left uncompared. The report, JSON and exit codes are `snapshot-diff`'s. `capture --base` instead rebuilds the ref's fixtures, so its DOM changes too. On Carbon's 218 pages (2 themes, forced states) a `compare` takes about as long as two captures (85 s at 4 tabs) and writes nothing.

`compare` and `bisect` read only what the change can reach. The rules that differ between the two stylesheets (removed, added, moved against the others, or edited in place, for the declarations that changed) have their selectors relaxed to every element they could style in any state: `:hover`, `:checked` and other states a static DOM can't decide are dropped, a pseudo-element becomes its element, and a `:not()` or `:has()` that held one goes whole. A page none of them match isn't loaded, as no rule that styles it changed. On the others, only the matched elements, their descendants (inheritance) and their ancestors are read, and only forced states that can record them, for the properties those rules declare plus what follows from them (logical twins, currentColor users after a `color` change, every property after a font or custom property change). When the change can move a box, every element of the page is read again for the values `getComputedStyle` resolves against layout (`width`, `top`, `margin`, `transform`, …). Which elements each page has comes from a page index: every page's element tree (tags, attributes, structure), recorded once by loading the fixtures as they are and cached under `node_modules/.cache/crassus` by the fixture files' contents, stylesheets aside and with bundlers' asset hashes (`mount-CYiQnMsr.css`) dropped, so editing the CSS and rebuilding the fixtures keeps it. When it's rebuilt, the reach line says why (`fixture files changed: page.html`). Before capturing, `compare` prints the reach (`the changed rules (12 selectors) reach 3 of 124 pages (41 elements, with their descendants)`). Changes it can't scope read everything, and say why: an at-rule outside style rules (`@font-face`, `@property`, `@import`), the cascade layer order, or `@container` rules with a change that can move a box. The results are the same as reading everything; the report's element-entry count is the entries read. On carbon-components-svelte's 124 fixture pages (white, 1280 × 900, forced states, 4 tabs), a one-declaration color change took 2.1 s instead of 48.2 s, a padding change on `.bx--btn` 12.6 s instead of 47.2 s (35 pages reached, each read whole for layout), and 25 runs of CSS refactor commits (82 commits, `2d710c03e..97164eeec`) 288 s instead of 1,218 s, with identical results on every one (`eval/carbon/scope.ts`). Building the page index is one load of each page, 20 s there, once per fixture build. `--no-scope` reads everything. When no rule differs between the stylesheets (a comment or whitespace aside), nothing is built or loaded: `compare` says so and exits 0, `--tokens` included, as no value nor what drives it can change. As no page is loaded, none is checked against `readySelector` either, so a not-ready page (one `allowNotReady` would otherwise need) doesn't fail that run. Without `--report`, `compare` still prints the cards' counts and a line per visible or token-detached card, built from the values alone: a token card's id is the one `--report` gives, the others' ids come with their causes under `--report`.

`compare --explain` reopens each changed page on both sides and asks Chrome which declaration each changed property's value comes from: the selector and its source line (through the stylesheet's source map, as `dead` and `diff` report), following `inherit` and inheritance up to the ancestor that set it. Each example in the report says `won by .bx--btn (css/_button.scss:42) on both sides` or `base: … -> head: …`; `--format json` has it for every changed element. `compare --visual` screenshots each changed element on both sides (its box padded to at least 24 × 16, plus 8 px for outlines and shadows; nothing for an element that renders no box), taking one screenshot of the elements a forced state shows (or of those shown without one) and cropping each from it in memory, and compares the pixels. Where they differ at the same size, it scores how far apart they look with CIEDE2000 (ΔE, over the pixels that differ): below 1, a just-noticeable difference, the element counts as imperceptible. The report counts how many changed elements' pixels differ, overall and per change, with the largest and mean ΔE and how many were imperceptible (`#161616 -> #000` text is about 4: visible, but subtle). Pixels are per element, so a change on an element where another change shows counts as differing. Neither changes the exit code. One screenshot per state on a page, not per element: on Carbon's 124 fixture pages, recoloring the primary blue changed 1,388 elements, and `--visual` added 23 s to the compare (50 s before); pixels differed on 1,120, of which 1,114 imperceptibly (a one-step recolor).

`bisect <from>..<to>` runs `compare` along a range of first-parent commits: it cuts the range into segments (consecutive commits of one conventional-commit type, or one per commit), builds the library stylesheet at each boundary (in a worktree, cached by commit, as `diff --base` does), skips a segment whose stylesheet is byte-identical at both ends, and compares the rest on today's fixtures. A segment with visible changes is halved, and the halves compared, down to the commits that made them. The report lists every segment and half with its result, then the changes each responsible commit (or segment, when its halves cancel out) made, as `compare` prints them. It exits 1 when a commit changed what users see. On carbon-components-svelte, 7 commits (`430e4fe6b~1..ee4dcf506`) took 4 minutes: a `refactor(css)` that built identical CSS, two `feat` commits with no visible change on the fixtures, and 4 `docs` commits.

`compare --report <dir>` and `bisect --report <dir>` turn the changes into **change cards**, one per root cause: the rule that differs between the stylesheets among each change's winners, the one that stopped winning first (`.bx--tooltip--definition .bx--tooltip__trigger` no longer sets `color`), else the one that started, or the rule edited in place when it wins on both sides (`.bx--tag` changes `background-color` from one value to another). A change no changed rule explains goes to its element's card (an `inset` that follows a `position`), and one with neither falls back to its winners, then to its value. What no one can see gets a card of its own, apart: one per cause, with every reason that hides its elements. A rule is one cause whichever selector of its list matched: `.bx--assistive-text, .bx--visually-hidden` is one card, with its elements counted per selector (`selectors`). So the 6 nested-table cells #3839 changed in 3 properties read as one card, and the TooltipDefinition regression as one: 77 elements on 4 pages. Each card has a stable id (the cause and its properties, not line numbers), a verdict (`visible`, `imperceptible` when every element's pixels differ by less than ΔE 1, or `invisible` with its reason), what changed (folded, with counts), where (a CSS selector, the snapshot path and the element's markup), why (the rule at its source line, with a few lines of it, `vscode://` and GitHub links, and with `bisect` the commit), the blast radius (elements and pages), a suggested fix from the provenance (the values a lost rule set), crops of an element on each side with a heatmap of what differs, and a one-sentence text alternative. The directory holds `report.json` (`crassus/report@1`), an offline `index.html` (filters by verdict and text, the cards by root cause, a before/after slider, code panes), `report.md` for a PR, the crops, and both stylesheets. The terminal gets one line per verdict and per card. Then, for one card:

- `crassus explain <id>` prints it as Markdown (`--format json` for the card), any unique prefix of the id will do;
- `crassus repro <id>` writes `repro/<id>.html`: the element in its ancestors, each side's stylesheet cut down to the rules that can style it (states and pseudo-elements relaxed as `compare` does), and a toggle;
- `crassus reduce <id>` finds the fewest declaration edits of the change that still give the card's element its head value (`--property` picks one; the card's most frequent change by default). The two stylesheets become one unit per declaration and selector, in order; the edits are the units on one side only (a Myers diff); and delta debugging (ddmin) tries subsets in one loaded page, the library stylesheet replaced in place by base with those edits applied, until removing any edit left stops reproducing it. It prints the edits and writes them to `reduce/<id>.json`. The TooltipDefinition regression's card (`28e700f30..7e301af6f`) reduces to the one dropped declaration, `.bx--tooltip--definition .bx--tooltip__trigger { color: var(--cds-text-01, #161616) }`, out of the commit's 4,224 declaration edits, in 19 tries and 2.6 s; #3839's nested-cell border color takes 3 interacting edits (161 tries, 5.8 s).
- `crassus verify <id>` compares the report's base stylesheet with the project's now on the card's pages, says per property whether its elements match base again, and exits 0 once they all do.

With `--tokens cds-` (or `browser.tokens: "--cds-"`), `compare` and `bisect` also check what drives each value. After reading a page, they set every custom property with the prefix to a sentinel of its type (a hue of its own for a color, an odd length, a font family named after it), read the same elements again, and note which properties carry which token's sentinel. A property that followed a token on base and follows none on head is **token-detached**: it stopped changing with the theme, whatever its pixels say, and it fails the run, even when its value is the same (listed apart in the report) or the element is hidden now. One that follows other tokens is re-tokened, shown but not failed on. Each change group says how many of its elements detached and from which tokens, and change cards get a `token-detached` verdict that comes before `visible`. The TooltipDefinition regression (`28e700f30..7e301af6f`) is one: the trigger's `color` followed `--cds-text-01` and now comes from the user agent's `button` rule, ΔE about 4. Tracing reads each page once more, in unforced states only, and only finds tokens used directly (`var()`), not through `calc()` or `color-mix()`. On carbon-components-svelte's 124 fixture pages it took the TooltipDefinition regression's compare from 18.6 s to 19.0 s (`eval/carbon/tokens.ts`).

`crassus tokens --tokens cds-` reports, over the fixtures as built, which tokens drive which properties on how many elements and pages, the traced tokens nothing follows, and colors that follow no token, by property and value, in two lists: hard-coded, where an author rule (or style attribute) sets a literal, and user agent defaults, where none does (a `<button>`'s `buttontext`; on a themed element, a missed token). A color an element inherits counts once, where it's set. Each list says what it leaves out, per entry and in all: colors on elements no one can see, and inherited ones (`omitted` in JSON). Evidence, bounded by the fixtures. On carbon-components-svelte (white, 1280 × 900) it traced 356 `--cds-*` tokens over 124 pages in 23.6 s: 120 followed, 236 unused, and among the colors that follow none, the avatars' background colors.

`crassus approve <id...>` records cards as intended changes in `crassus.approved.json` at the project root, with the changes each made (`property: before -> after`): the Jest-snapshot workflow for computed styles. Once the file exists, `compare` and `bisect` build cards on every run (turning on `--explain`) and fail only on a visible card it doesn't approve, or on elements on one side only. A card is approved when its id is and every change it makes is one approved, so the same cause on more elements stays approved and new values don't. `bisect` halves, and reports, only what isn't approved. The terminal lists the cards it would fail on with the `crassus approve` line to run, and the HTML report has a checkbox per card that builds it. Commit the file with the change it approves.

Forcing a state takes CDP calls per element, so `capture`, `compare` and `bisect` force one only where some rule uses it: a `:hover` state is forced on an element when a rule's selector, up to the compound holding `:hover`, matches it (`:focus-within` on it or an ancestor; inside `:has()`, anywhere), and focus always (the user agent's focus ring), as are `:active` on links, buttons and form controls and `:hover` on options (the user agent styles them). Elsewhere the state's records are the plain ones, taken from the plain read with transitions and animations stopped as the state phase stops them (elements with animations are still read). On carbon-components-svelte's 124 fixture pages (white, 1280 × 900, 4 tabs) that forces 2,749 of 5,478 reachable states, makes 6,201 CDP calls instead of 10,698, and takes the state phase from 20.1 s to 13.7 s (summed over tabs; the capture from 25.4 s to 23.1 s), with every one of the 26,191 records the same (`eval/carbon/states.ts`). Rewriting state selectors in place (`--engine webkit`, or `states: "rewrite"`) is cheaper still, but not the same: 166 records differ there, mostly the user agent's styles for focused links and hovered options, so Chrome keeps CDP.

Before reading styles, `capture` pauses infinite animations at their start and finishes the others, so a spinner doesn't differ between two runs of the same CSS. It forces only states a user can reach: no `:focus` or `:active` on a disabled element, no `:focus` on one that can't take focus (a `<li>`, a link without `href`, a hidden element), and none inside `inert`.

`coverage` is mutation testing for the library stylesheet. On each fixture page, with the configured stylesheet swapped in, it takes every rule that styles an element (its selector relaxed to find them, with its states set as attributes on the elements they name), removes each of its declarations in turn from the page's CSSOM, and reads the elements again. A declaration is **covered** when removing it changes a value somewhere; it **decides nothing** when its rule styles elements but no value depends on it (always overridden, or the same as what wins without it); it's **unmatched** when its rule styles no element in any page, theme, viewport and state run; and **condition never holds** when its `@media` or `@supports` never held there. The report gives the percentage, the least covered files and components, and the uncovered declarations at their source line, with an element an unmatched rule would style (built for its selector). `--format json` lists every declaration. All of it is evidence bounded by the fixtures: a theme or viewport not run reads as uncovered. On carbon-components-svelte's 124 fixture pages (white, 1280 × 900) 4,363 of its 13,023 declarations are covered (33.5%): 6,447 are unmatched, 1,731 decide nothing and 482 sit under a condition that never held, in 184–391 s depending on load. Against `crassus usage` on the same pages (`eval/carbon/coverage.ts`), 3,696 covered declarations won somewhere and 6,446 of the unmatched ones never matched; the least covered are `css/_box.scss` (0 of 368: no fixture renders `.bx--box`) and the grid's `row` (0 of 292).

`usage` writes `usage.json` (every matched declaration with its counts, never-matched rules, dead declarations and fold candidates) and `report.md`: declarations that matched and never won, with what they lost to, by size (losses only to `prefers-reduced-motion`, `prefers-contrast` or `forced-colors` rules are left out, as alternatives for a user preference); fold candidates, which always lose to the same single rule; and rules that never matched. All of it is bounded by the fixtures, themes, viewports and states the run covered.

`diff` prints what changed between the two builds: the specificity profile, the files carrying the most selectors at three or more classes, the minified size as Bun minifies it (a trend, not a budget), dropped, new, rewritten and moved rules, and two sections of flips: **cascade flips**, where the winner between two rules that may match one element changed (these fail), and **order-tie flips** from rules that only moved (review). Both are rung 1 heuristics: confirm them with a computed-style snapshot (rung 3).

`diff --confirm` checks each flip in Chrome. Most pair rules no element ever carries together, so a flip is first looked up in the fixtures' page index (the element trees `compare` records): if some element matches both rules (their states and pseudo-elements relaxed), the flip is rendered on that page's tree; if the fixtures use every class and attribute the pair needs and no element matches both, it's dropped as never seen. Otherwise an element both match is built (subjects and ancestors merged, siblings kept beside their element, or one chain nested in the other), as long as it nests components the way some fixture does, and rendered. Each render puts base's stylesheet, then head's, on the tree, with the rules' states set as attributes, and reads the property on the element: a flip whose value doesn't change is dropped too. Only confirmed flips fail the run; ones no element could be built for are listed for review. On 25 runs of CSS refactor commits (`2d710c03e..97164eeec`, `eval/carbon/flips.ts`, white, 1280 × 900), 3,410 of 3,667 flips (order ties included) were never seen on the fixtures and 201 changed nothing; the 42 flips of the two runs known to hold only noise (15 across components, 27 within one) were all dropped, and a real one, the icon-only tab's `padding` against `.bx--tabs--container`, was confirmed on `tabs-variants` and is a change there in `compare` too. The largest run's 1,000 flips took 10 s. Confirming sets a state on every element a rule names, reachable or not, so it can confirm what no user sees: 4 of the 10 confirmed on a fixture don't change in `compare`.

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
| `fixtures` | The fixture directory, or `{ dir, build? }`. For `capture --base`, `build` runs in a fresh worktree with only tracked files, so it must also build anything the fixtures load that's gitignored (compiled CSS). |
| `themes` | Themes to load each page in (default: one run, no attribute). |
| `themeAttribute` | The `<html>` attribute a theme is set as (default `theme`). |
| `sheetMarker` | Text only the library stylesheet contains; `usage` needs it to tell that sheet from the page's others. |
| `viewports` | `{ width, height }[]` (default 1280 × 900). Cover your breakpoints: at one width, rules for the others read as never matched. |
| `tokens` | The design tokens' custom-property prefix (`--cds-`): `compare` and `bisect` trace them, and `tokens` reports on them. |
| `readySelector`, `readyTimeoutMs` | Wait after load until the selector matches (up to 5 s by default). Pages that never match are reported. |
| `settleMs` | `capture`: wait after load (default 500). |
| `engine`, `concurrency`, `chromePath` | Defaults for `--engine` and `--concurrency`, and the Chrome binary. |

In GitHub Actions, `--format github` puts each finding on the PR diff at its source line:

```yaml
- run: bunx crassus diff --base origin/${{ github.base_ref }} --format github --summary "$GITHUB_STEP_SUMMARY"
```

`--summary` puts the full human report in the job summary from the same run.

## API

### `crassus`

| Export | Description |
|:---|:---|
| `parseRules(css, positions?)` | One `Rule` per selector: condition context (`@media` / `@supports` / `@container`), cascade layer and its rank, `@scope`, canonical selector, specificity, subject, declarations, source order, and with `positions` the line and column. |
| `resolvePath(path, root)` | The element a snapshot path (`body>div.a.b[2]>p@hover`) names, under `root` (`document.documentElement`), in any DOM. Self-contained, so a Playwright script can evaluate it in the page: `` page.evaluate(`(${resolvePath})(${JSON.stringify(path)}, document.documentElement)?.outerHTML`) ``. |
| `canonicalSelector(text)`, `canonicalContext(name, prelude)` | A selector, or one `@name prelude`, spelled as `Rule.selector` and `Rule.context` spell it, whatever the source's spacing. Keys a browser's matched rules (CDP's selector, media, supports and container text) to `parseRules`. |
| `SHORTHANDS` | Shorthand (or legacy alias) → the longhands it sets, generated from Chrome's CSSOM: 119 shorthands, including logical, grid and experimental ones. Longhands are spelled as CDP lists them beside a matched shorthand (`margin-block` sets `margin-block-start` and `margin-block-end`), so a usage driver of its own can expand a shorthand CDP sends without `longhandProperties`. |
| `deadDeclarations(css, positions?)` | Declarations that can never win: every selector of the rule is repeated, in the same context and scope, by a rule later in the cascade (importance, then layer, then source order) setting the same property or a covering shorthand (logical/physical twins included). Fallbacks, vendor prefixes and legacy aliases (`grid-gap` before `gap`) aren't reported. |
| `cascadeDiff(base, head, { componentOf? })` | Between two builds' rules: removed, added, rewritten (same declarations, new selector), dropped and new rules, context and layer moves, moved rules, and **cascade flips**, where the winner between two rules that may match one element changed. `moveFlips` are the order ties of rules that only moved. |
| `defineConfig(config)` | Types a `crassus.config.ts`. |

Types: `Rule`, `DeadDeclaration`, `CascadeDiff`, `Flip`, `Config`, `BrowserConfig`, `Stylesheets`, `PathElement`.

### `crassus/browser` (Bun)

Real-browser rungs on [`Bun.WebView`](https://bun.sh/docs/runtime/webview): Chrome or Chromium over CDP (Playwright's cached `chrome-headless-shell` when installed, else auto-detected), or the system WebKit on macOS. No Playwright and no browser download.

| Export | Description |
|:---|:---|
| `capture(options)` | Computed-style snapshot of every element, `::before`/`::after` and forced `:hover`/`:focus`/`:active`, per theme and viewport, one gzipped file per page. States come from CDP (exact) or from rewriting state selectors in place (any engine), on the elements that can reach them. |
| `readSnapshot(file)` | One `capture` file as a `Snapshot`: element path → property → computed value. Elements with the same style share one record object. |
| `diffSnapshots(baseDir, headDir, { examples? })` | Compares two `capture` directories: changed element paths per page, and every change grouped by `(property, before -> after)` with counts and example paths. Pages and paths on one side only are listed, not diffed, and so are properties only one side recorded (`uncompared`). Changes carry the properties folded into them (`aliases`) and, when no one can see them, why (`invisible`). Throws `IncompleteCaptureError` for a directory without a manifest. |
| `runUsage(options)` | Which declarations of the library stylesheet (the one containing `sheetMarker`) match and win on every element, over all themes and viewports. `matcher: "cdp"` asks Chrome per element; `matcher: "dom"` matches in the page with `Element.matches()` in one round trip per page, on Chrome or WebKit. |
| `compareCss(options)` | `capture`'s options with `dir` (the fixture directory), `sheetMarker`, `base` and `head` CSS, and optionally `explain` and `visual` (Chrome): every page captured with each swapped in for the library stylesheet, diffed page by page into a `SnapshotDiff` (plus `ms`, `notReady` and `impact`), keeping no snapshots. By default only what the changed rules can reach is read (`scope: false` reads everything); `indexDir` keeps the page index between runs, and `onImpact(impact)` hears the reach before any page is captured. |
| `serveFixtures(dir, { swap? })` | Static fixture server that sets a theme attribute before first paint. `swap: { marker, css }` serves `css` in place of the largest `.css` file containing `marker`. |

Both browser runs take:

- `viewports: { width, height }[]`: every page at each size (default one, 1280 × 900; `width`/`height` still set a single one). Use enough to cover the stylesheet's `min-width`/`max-width` breakpoints, or rules outside them read as never matched. With several, capture files are named `<name>.<theme>.<W>x<H>.json.gz`.
- `readySelector` (and `readyTimeoutMs`, default 5000): wait after load until the selector matches, for content that mounts late. A page that never matches is still read, and returned in `notReady`.

`compareCss` also takes `tokens` (a custom-property prefix) to trace design tokens, which fills `pages[].tokens` (`TokenChange`: what a property followed on each side) and `groups[].tokens`.

`IncompleteCaptureError` is exported too. Types: `CaptureOptions`, `CompareOptions`, `Impact`, `TokenChange`, `Report`, `Card`, `CardChange`, `CardElement`, `Cause`, `Fix`, `Verdict` (the shape of `report.json`), `ServeOptions`, `UsageOptions`, `UsageFile`, `Snapshot`, `Viewport`, `SnapshotDiff`, `SnapshotPageDiff`, `SnapshotDiffOptions`, `PageDiff`, `PropertyChange`, `ChangeGroup`, `Uncompared`, `Winner`, `Explained`.

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
| Computed-style snapshot, 218 pages | 471.7 s | **43.9 s** (CDP, 8 tabs, identical output\*) |
| Cascade usage, 218 pages | 1,171.7 s | **22.3 s** (`dom` engine, 8 tabs) |

\* Identical to the Playwright tool when every state is forced. By default `capture` skips states no user can reach (on 228 pages: 6,144 of the old tool's 55,222 entries, mostly inside a closed, `inert` modal), so those entries are missing, and an element under several forced ones keeps the state of the last one that can reach it (770 values differ). Run `eval/carbon/snapshot.ts` to see it.

Coming from scripts of your own built on css-tree and Playwright? See [Migrating from css-tree-based cascade tools](docs/migrating-from-css-tree-tools.md).

## Limitations

- **`dead` assumes the later declaration applies.** If a browser rejects its value or its selector, the earlier declaration still wins there. Known fallback patterns (vendor prefixes, `fit-content`, `dvh`, legacy aliases) aren't reported.
- **Logical properties assume a horizontal writing mode.** `inset-block-start` and `top` share a slot; the inline axis is left alone.
- **Two different `@scope` roots are compared by source order.** Which is closer depends on the DOM. A scoped rule does beat an unscoped one at equal specificity.
- **Scoped compares assume the stylesheet doesn't change the DOM.** The page index is recorded with the fixtures' own stylesheet, so a page whose script renders different elements under another one (measuring, virtualizing) can be skipped when an element only that stylesheet renders would match. Run with `--no-scope` when your fixtures do that.
- **Selector performance is out of scope.** How long Chrome spends matching selectors (DevTools' selector stats, `RecalcStyleDuration`) is a measurement, not a claim about the cascade, so it has no rung. `eval/carbon/selector-stats-harness.ts` is a measurement spike kept for comparison and won't ship; keep a perf harness of your own.
