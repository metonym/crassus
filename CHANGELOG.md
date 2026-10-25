# Changelog

## 0.3.1 — 2026-10-25

**Features**

- The config's `inputs` (the paths the stylesheets are built from) make
  `diff --base`, `compare` and `bisect` build a base from just those
  paths, written out with `git read-tree` and `checkout-index` instead of
  a whole `git worktree`, and cache it by the git objects at those paths,
  the config file and the lockfile instead of by commit: every commit
  that left them alone reuses the build. `diff` and `compare` cache the
  head the same way while the paths match `HEAD`. On
  carbon-components-svelte (`diff --entry all`, 4 to 7 runs interleaved
  with the previous build, a loaded machine, medians):

  | Run                                                     | Before |  After |
  | :------------------------------------------------------ | -----: | -----: |
  | Base never built                                        | 10.0 s |  8.9 s |
  | Same command again                                      |  8.3 s | 0.43 s |
  | Base on another commit, same `css/`                     | 11.6 s | 0.35 s |
  | Base on a commit that changed `css/`, head built before | 11.4 s |  7.2 s |

  Writing `css/` at a ref took 0.17 s instead of 1.2 s for a `git
  worktree` add and remove. Without `inputs` nothing changes.
- `crassus/git` exports `compileAt(ref, { cwd?, config?, entries?, cache? })`:
  the project's stylesheets at a ref (or the working tree), built and
  cached as `diff --base` does, for scripts that need the compiled CSS.

## 0.3.0 — 2026-10-12

**Breaking**

- More changes count as invisible, so they're listed apart and no longer
  fail `snapshot-diff`, `compare` or `bisect`: anything in an absolutely
  positioned box clipped to nothing (`clip: rect(0 0 0 0)`,
  `clip-path: inset(50%)`, or a 1px box with `overflow: hidden`, as
  screen-reader-only text is) or off the page; painted properties under
  `opacity: 0` (on the element or an ancestor), in an in-flow box clipped
  that way, off the page or clipped away by an `overflow` ancestor; text
  drawn in the color of the background behind it; and a 0 × 0 box's own
  background and border. `capture` records the geometric reasons as a
  `--cr-hidden` value on the element (never compared). On carbon-components-svelte's
  `28e700f30..7e301af6f` (124 fixture pages), the clipped
  `.bx--assistive-text` moves that used to read as changes are now
  invisible (`clip: rect(0 0 0 0)`, 30 elements), as are 29 changes under
  `opacity: 0` and 21 off the page: 248 visible changes instead of 327
  (`eval/carbon/scope.ts`, `eval/carbon/visual.ts`).
- `ChangeGroup.pixels` has an `imperceptible` count. `--visual` doesn't
  screenshot elements already proven invisible (a clip, `display: none`,
  off the page), so their groups have no `pixels`.
- Changes to `transition-*` are invisible ("transition only"): captures
  settle transitions, so what they animate never shows in a still. They no
  longer fail a run.
- `compare` and `bisect` with no rule differing between the stylesheets
  (comments and whitespace aside) build no fixtures and load no page: they
  say so and exit 0, so a page that never gets ready can't fail such a run.
  On a clean carbon-components-svelte checkout (`compare --entry all`,
  white, 1280 × 900) that's 3.3 s instead of 7.2 s with the page index
  cached, 21.2 s when it had to build. `--no-scope` still reads
  everything.

**Features**

- `compare --visual` scores how far apart an element's pixels look, with
  CIEDE2000 over the pixels that differ: `pages[].deltaE[path]` and
  `groups[].deltaE` hold the largest and mean ΔE, and an element whose
  pixels differ by less than 1 everywhere counts as imperceptible (in the
  report, per change and overall). The TooltipDefinition trigger
  (`#161616 -> #000`) reads ΔE 3.5 on average (6.3 at most) on its page.
- `compare --visual` takes one screenshot per state on a page instead of
  one per element: elements forced into the same state share one when
  their boxes don't overlap and neither contains the other, and each is
  cropped from the decoded PNG in memory. Elements already proven
  invisible get none. Its cost over a plain `compare`, measured with
  `CCS_ROOT=… bun eval/carbon/visual.ts` on carbon-components-svelte's
  124 fixture pages (white, 1280 × 900, forced states, 4 tabs), before and
  after:

  | Change                  | Changed elements |  Before |          After |
  | :---------------------- | ---------------: | ------: | -------------: |
  | `28e700f30..7e301af6f`  |              172 |  +9.2 s |         +2.3 s |
  | `2d710c03e^..7e301af6f` |              172 |  +7.8 s |         +5.9 s |
  | `660b2936a` (#3839)     |               12 |  +1.7 s | −0.1 s (noise) |
  | Recoloring `#0f62fe`    |            1,388 | +50.1 s |        +23.1 s |

- `compare --explain` and `--visual` read the base side on the page the
  head side was just read on, by switching its library `<link>` to the
  base sheet (the head server serves it at the same path with
  `?cr-sheet=alt`), instead of loading, settling and tagging the base page
  again; a page whose library sheet isn't a `<link>` is still reloaded.
  Recoloring `.bx--visually-hidden` (49 of 124 pages reached, white,
  1280 × 900, 4 tabs, load 4.8–5.8): 17.5 s and 16.6 s plain, 21.7 s and
  22.3 s with `--report` (1.24× and 1.34×), against 40.8 s (2.2×) before
  invisible elements went unscreenshotted and 1.52–1.61× before the
  switch; `--explain` alone went from 26.7 s to 21.2 s. Same cards,
  winners and crops.
- `compare` and `bisect` read only what a stylesheet change can reach.
  The rules that differ (removed, added, moved against the others, or
  edited in place, for the declarations that changed) have their
  selectors relaxed to every element they could style in any state (no
  `:hover` or other states, a pseudo-element as its element). A page none
  of them match isn't loaded; on the others only the matched elements,
  their descendants and ancestors, and the forced states that can record
  them are read, for the properties those rules can move (plus logical
  twins, currentColor users, and layout-resolved values when a box can
  move). Pages are matched against a page index of each fixture's element
  tree, built once per fixture build and cached under
  `node_modules/.cache/crassus`. `compare` prints the reach before
  capturing, and JSON has it as `impact`. Changes outside style rules
  (`@font-face`, `@property`, `@import`, layer order) read everything.
  `--no-scope` (`scope: false` in `compareCss`) reads everything; with
  scoping, the report's element-entry count is the entries read.
  Measured with `CCS_ROOT=… bun eval/carbon/scope.ts` on
  carbon-components-svelte's 124 fixture pages (white, 1280 × 900, forced
  states, 4 tabs), against reading everything, with identical results on
  every case:

  | Change                                                                           | Pages reached | Everything |  Scoped |
  | :------------------------------------------------------------------------------- | ------------: | ---------: | ------: |
  | One color declaration (`.bx--tag--red`)                                          |             1 |     48.2 s |   2.1 s |
  | One padding declaration (`.bx--btn`)                                             |            35 |     47.2 s |  12.6 s |
  | `28e700f30..7e301af6f` (the TooltipDefinition regression, 411 changed selectors) |            29 |     50.7 s |  12.4 s |
  | `660b2936a` (#3839)                                                              |             8 |     87.1 s |   4.9 s |
  | 25 runs of CSS refactor commits (82 commits, `2d710c03e..97164eeec`)             |         0–124 |  1,217.6 s | 287.8 s |

  Building the page index took 19.8 s. Of the 25 runs, 6 reach no
  page (0.3–0.5 s each), 2 change `@font-face` rules and read everything,
  and 1 moves the theme token block, which reaches every page. The index
  is keyed on the fixture files but their stylesheets (it records only the
  DOM), with bundlers' asset hashes (`mount-CYiQnMsr.css`) dropped and
  same-named chunks ordered by content, so editing the CSS and rebuilding
  the fixtures keeps it: after a `.scss` edit and a fixture rebuild it
  reads from cache in 0.1 s instead of rebuilding in 90.7 s. A rebuild
  says why (`page index built (fixture files changed: …)`).
- `compareCss` takes `scope`, `indexDir` and `onImpact`, and returns
  `impact`; the `Impact` type is exported from `crassus/browser`.
- Change cards: `compare --report <dir>` and `bisect --report <dir>` group
  changes by root cause, the rule that differs between the stylesheets
  among each change's winners, into cards with a stable id, a verdict,
  what changed, where (a CSS selector and the element's markup), why (the
  rule at its source line with an excerpt and links, and the commit with
  `bisect`), the blast radius, a suggested fix, crops of each side with a
  heatmap, and a text alternative. The directory holds `report.json`
  (`crassus/report@1`), an offline `index.html`, `report.md` and the
  crops; `--format markdown` and `--format sarif` print the cards.
  `crassus explain <id>`, `crassus repro <id>` (a standalone page with
  each side's stylesheet cut to the rules that can style the element, and
  a toggle) and `crassus verify <id>` (per property: does it match base
  again) act on one card. On three known changes
  (`CCS_ROOT=… bun eval/carbon/cards.ts`, 124 fixture pages, white,
  1280 × 900): the TooltipDefinition regression is one visible card
  (`.bx--tooltip--definition .bx--tooltip__trigger` no longer sets
  `color`, 77 elements on 4 pages), #3839's nested child-row cells one
  card, and the flattening's visible cards are all on the consumer-override
  fixture. `verify` on the regression's card reports `color` matching base
  with the upstream fix's stylesheet (`3e7ae6001`), and `position` still
  changed. A cause is the rule that stopped winning, the one that started,
  or a rule edited in place that wins on both sides (`.bx--tag` changes
  `background-color` from one value to another); a rule is one cause
  whichever selector of its list matched (`selectors` counts the elements
  per selector), and what one cause hides is one invisible card with its
  reasons listed. Card markup leaves out comments (frameworks' empty
  anchors). Without `--report`, `compare` prints the cards' counts and a
  line per visible or token-detached card, built from the values.
- Approvals: `crassus approve <id...>` records change cards as intended in
  `crassus.approved.json` (`crassus/approved@1`: each card's id and its
  `property: before -> after` changes). With the file, `compare` and
  `bisect` build cards on every run and fail only on visible cards it
  doesn't approve (or on elements on one side only); a cause with new
  values isn't approved. The HTML report has a checkbox per card that
  builds the command. On carbon-components-svelte (white, 1280 × 900),
  approving #3839's two cards made `bisect 660b2936a^..660b2936a --only
  data-table` exit 0 instead of 1, and `28e700f30..7e301af6f` still
  failed on its own cards. With cards,
  `--format json` stays one document and adds `cards: { summary,
  failing }`.
- Token tracing: `compare --tokens cds-` and `bisect --tokens cds-` (or
  `browser.tokens: "--cds-"`) read each page again with every token set to
  a sentinel of its type, and note which properties follow which token. A
  property that followed one on base and none on head is token-detached:
  it fails the run even when its value is unchanged or its element is
  hidden, groups count it, and change cards get a `token-detached` verdict.
  Measured with `CCS_ROOT=… bun eval/carbon/tokens.ts` (124 fixture pages,
  white, 1280 × 900, `--visual` off): the TooltipDefinition regression's
  card is token-detached (`color` stopped following `--cds-text-01`), and
  tracing took that compare from 18.6 s to 19.0 s (#3839: 7.1 s, 6.9 s;
  the flattening: 24.7 s, 27.5 s at load 4.6; a second run at load 8–18
  measured 24.8 s → 26.8 s, 8.4 s → 9.3 s and 31.7 s → 52.8 s). In the terminal,
  detachments group as style changes do, `color`'s followers, logical
  twins and longhand sets folded: the TooltipDefinition trigger's is one
  line, `30×  color: --cds-text-01 -> none`, with the rest under `also:`.
- `crassus tokens --tokens cds-`: which tokens drive which properties on
  the fixtures, unused tokens, and colors that follow none in two lists:
  hard-coded, where an author rule sets a literal, and user agent
  defaults, where none does (on a themed element, a missed token). Each
  says what it leaves out: colors no one can see, and inherited ones,
  counted in the list of the ancestor that sets them (`omitted` in JSON).
  On carbon-components-svelte: 356 tokens traced over 124 pages in 23.5 s,
  120 followed, 236 unused; the hard-coded list leads with avatar and
  header backgrounds, and the user agent's `color: rgb(0, 0, 0)` is 285
  `<button>`s listed, 386 unseen and 841 inherited.
- `crassus diff --confirm` renders each cascade flip in Chrome: on a
  fixture page's element tree where some element matches both rules (from
  the page index), else on an element built for both, as long as its
  components nest as some fixture's do; a pair no fixture element carries,
  when the fixtures use all its classes, is dropped as never seen, and a
  flip whose value doesn't change is dropped too. Only confirmed flips
  fail. Measured with `CCS_ROOT=… bun eval/carbon/flips.ts` (white,
  1280 × 900): 3,667 flips over the 25 runs of refactor commits
  (order ties included), 3,410 never seen, 201 no change, 25 confirmed, 31 left for
  review; all 42 flips of the two runs known to hold only noise
  dropped; the icon-only tabs' `padding`
  flip confirmed on `tabs-variants`, where `compare` sees it too. The
  largest run's 1,000 flips took 10 s.
- `crassus reduce <id>` delta-debugs a change card's stylesheet change down
  to a 1-minimal set of declaration edits that still give its element the
  head value: one unit per declaration and selector, a Myers diff for the
  edits, and ddmin over them in one loaded page with the library
  stylesheet swapped in place. On carbon-components-svelte
  (`28e700f30..7e301af6f`, white, 1280 × 900): the TooltipDefinition card
  reduces to the single dropped `color` declaration out of 4,224 edits, in
  19 tries and 2.6 s; #3839's nested-cell `border-top-color` to 3 edits in
  161 tries (5.8 s), its `tbody th` color to 1 in 12.
- Cheaper forced states: `capture`, `compare` and `bisect` force a state
  over CDP only on elements some rule's state applies to (a state selector
  index from every stylesheet: the selector up to the compound holding the
  state, `:focus-within` up the tree, `:has()` anywhere), and focus always,
  `:active` on links and controls and `:hover` on options for the user
  agent's styles. The other states' records are the plain ones, copied
  with transitions and animations stopped as the state phase stops them.
  `stateIndex: false` forces every reachable state. Measured with
  `CCS_ROOT=… bun eval/carbon/states.ts` (124 fixture pages, white,
  1280 × 900, 4 tabs): 10,698 → 6,201 CDP calls, 5,478 → 2,749 states
  forced, state phase 20.1 s → 13.7 s (summed over tabs), capture 25.4 s →
  23.1 s, and 0 of 26,191 records different. Rewrite mode stays off for
  Chrome: 166 records differ from CDP (the user agent's focused-link
  `outline-offset` and option backgrounds), so it isn't proven equal.
- Browser runs back off under load: while the 1-minute load average is
  above the core count, every tab but one waits. A run says so once on
  stderr, and its summary line ends with the time spent on one tab;
  `loadAverage` on the visit options replaces the reader.
- `crassus doctor` checks the Chrome a run would use (and starts it), tabs
  against cores, the load, free disk, the fixture pages, what
  `sheetMarker` finds and `browser.tokens`, with a fix for each problem;
  exit 1 on an error.
- `compare` records a CSS selector for each changed element
  (`pages[].where[path].selector`, `nth-child` from `body`), and with
  `--explain` flags winners whose rule differs between the sides
  (`Winner.changed`).
- `crassus coverage` is mutation testing for the library stylesheet: on
  each fixture page it removes each declaration of each rule that styles
  an element from the CSSOM, one at a time, and reads those elements
  again. Each declaration is covered, decides nothing (its rule matches,
  no value depends on it), unmatched, or under a `@media`/`@supports`
  that never held; the report gives the percentage, the least covered
  files and components, and the uncovered declarations at their source
  line, with an element an unmatched rule would style. Always exit 0.
  `crassus coverage --entry all --themes white --viewport 1280x900` on
  carbon-components-svelte's 124 fixture pages: 4,363 of 13,023
  declarations covered (33.5%), 6,447 unmatched, 1,731 deciding nothing,
  482 under a condition that never held, in 390.7 s under load (184.1 s
  in a quieter run). Cross-checked against `crassus usage` with
  `CCS_ROOT=… bun eval/carbon/coverage.ts`: of the covered, 3,696 won
  somewhere, 663 aren't in usage's records and 4 matched without winning;
  of the unmatched, 6,446 never matched and 1 won; of those deciding
  nothing, 1,476 won somewhere (usage counts a win whose value is what
  wins without it, and merges a selector's `@media` copies) and 131
  never won. In a sample of 12 unmatched declarations, 11 name a class no
  fixture renders (`.bx--box-pl-12`, `.bx--col-lg-5`, the overflow
  menu's options) and one an element none does (`sup`).
- `tokens` and `coverage` name the pages that never matched
  `readySelector`, as `capture`, `compare`, `bisect` and `usage` do, and
  `snapshot-diff` names those of each capture it compares (`notReady` in
  JSON).
- `snapshot-diff` gives each example element a CSS selector to paste into
  DevTools (`body > div:nth-child(2) > p:nth-child(1)`), as `compare`
  does. `capture` files keep each element's index among its parent's
  children beside its record, so equal styles stay shared and
  `readSnapshot` returns the same records as before. On carbon-components-svelte's
  124 fixture pages (`crassus capture --themes white --viewport 1280x900`)
  snapshots grow 1.1% (791,358 → 800,034 bytes gzipped, 8,578 distinct
  styles either way), and each of the 10,356 element paths' selectors finds
  the same element as the path in Chrome.
- `browser.allowNotReady` lists fixtures known never to match
  `readySelector`: still read, with no warning and no failed run.

**Documentation**

- `docs/design/state-matrix.md`: a design, not built, for the state and
  data matrix. It covers factors and a fixture protocol, IPOG covering
  arrays, a real-event crawl next to forced states, invariants with their
  noise rules, shrinking, the output schema, resource limits and phases
  with golden cases from carbon-components-svelte. It's sized with
  scratch probes on that repo's 124 fixture pages: a pairwise array of 61
  rows for a 12-factor Button model (1,290,240 combinations); 22 size
  changes in 11,903 element-state pairs, all intended; and the contrast,
  target-size and clipping probes' false positives, which the noise rules
  remove.

**Fixes**

- The `crassus` bin is executable when installed from a directory.
- A `compile` hook that throws prints one line (the error and where, with
  paths as the project names them), naming the base ref when that's where
  it failed, and a base builds only the entries asked for.
- Paths outside the project print absolute, not as `../../../../tmp/…`.

## 0.2.0 — 2026-10-10

**Breaking**

- `capture` writes a `.crassus-capture` manifest once every page is
  written, and `diffSnapshots` (and `snapshot-diff`) read only the files it
  lists. A directory without one, from a capture that failed, is still
  running or came from crassus 0.1, throws `IncompleteCaptureError` (exit 2
  in the CLI) instead of being compared partially. Recapture 0.1
  directories.
- The CLI's default `--concurrency` is half the cores, at most 4, not 8.
- `diffSnapshots` compares only the properties both sides recorded. Each
  capture records the properties its own stylesheets declare, so a
  property only one side declares used to read as a change to or from
  `null` on every element (366 groups when a refactor stopped declaring
  `inset-inline-*`). It's now listed in `uncompared: { onlyBase, onlyHead }`
  (per page and overall), shown under "Not compared" and not failed on.
  `PropertyChange` and `ChangeGroup` `before`/`after` are `string`, never
  `null`.
- `diffSnapshots` folds one cause into one change per element: logical
  twins into the physical property, a full longhand set that changed the
  same way into its shorthand, and currentColor followers into `color`,
  listed in `aliases`. Changes no one can see on either side carry
  `invisible` with the reason (`display: none`, `visibility: hidden`,
  `no border`, `outline-style: none`, `text-decoration-line: none`), group
  apart, print in their own section and don't fail `snapshot-diff`.
  Recoloring Carbon's primary blue over 218 pages: 4,559 property changes
  before, 1,473 after (1,275 visible in 16 groups, 198 invisible); one
  border color reads as `border-color` instead of 8 changes.
- `capture` forces only states a user can reach: no `:focus` or `:active`
  on a disabled element, no `:focus` on one that can't take focus (no
  `tabindex`, a link without `href`, hidden), and no state inside `inert`.
  On carbon-components-svelte's 109 fixture pages that drops 2,668 of
  15,338 state entries (17%), all of them changes no user could see.
  Against the original Playwright tool (`eval/carbon/snapshot.ts`, 228
  pages) captures were identical before; now 6,144 of 55,222 entries are
  skipped (most inside a closed, `inert` modal) and 770 values differ
  where an element sits under several forced elements and keeps the last
  reachable one's state. With the checks off, they're identical again.
- `capture` files are gzipped `<page>.json.gz`, with each distinct computed
  style stored once (`{ props, styles, elements }`): most elements share
  theirs, so Carbon's 12 data-table pages take 154 kB instead of 48.6 MB
  (315×). `readSnapshot(file)` in `crassus/browser` reads one into the
  same `Snapshot` as before.

**Features**

- `crassus compare [--base <ref>]` (or `compare <base.css> <head.css>`)
  checks a CSS change against today's markup: it builds the library
  stylesheet at the ref and now (the config's `css`/`build` or `compile`;
  `--entry` picks one of several), serves today's fixtures with each
  swapped in for the stylesheet containing `sheetMarker`, and captures
  both sides of each page in the same tab, diffing as it goes. Nothing is
  written, and both sides record every property either stylesheet
  declares. Output and exit codes are `snapshot-diff`'s. On Carbon's 218
  pages it matches two captures and a `snapshot-diff` exactly, in about
  the same time, with no snapshots on disk. `compareCss(options)` in
  `crassus/browser` is the same run.
- `crassus bisect <from>..<to>` finds the commits in a range that changed
  computed styles on today's fixtures: segments of consecutive commits of
  one conventional-commit type (`--group-by type`, default, or `commit`),
  the library stylesheet built at each boundary (cached by commit), a
  segment skipped when its stylesheet is byte-identical at both ends and
  compared otherwise, and a segment with visible changes halved down to
  the commits that made them (`--no-split` keeps segments whole). It takes
  `compare`'s options, including `--explain` and `--visual`, and exits 1
  when a commit changed what users see.
- `compare --explain` (Chrome) names, for every changed property, the
  declaration that won on each side: selector and source line, through
  the stylesheet's source map, following `inherit` and inheritance to the
  ancestor that set it. Report examples read `won by .a (css/_a.scss:4) on
  both sides` or `base: … -> head: …`; JSON has it per element
  (`pages[].explain`, `groups[].examples[].explain`).
- `compare --visual` (Chrome) screenshots every changed element on both
  sides in its forced state and compares the bytes: the report counts the
  elements whose pixels differ, overall and per change (`pages[].pixels`,
  `groups[].pixels`). On Carbon's 218 pages, a primary-blue recolor
  changed 1,320 elements, 950 of them in pixels; 196 of the 198 changes
  marked invisible had identical pixels, and the other 2 sat on elements
  with visible changes too. With `--explain`: 127 s against 85 s.
- `resolvePath(path, root)` in `crassus` turns a snapshot path back into
  its element in any DOM, and is self-contained for `page.evaluate`.
- `capture --css <file>` captures today's fixtures with that CSS in place
  of the library stylesheet, and `serveFixtures(dir, { swap })` serves
  one swapped.
- Browser runs prefer Playwright's newest cached `chrome-headless-shell`
  over Bun's auto-detection, which picks an installed Chrome first and
  starts its helpers beside the user's own browser. `chromePath` still
  wins.
- `capture` stops before the disk fills: after each page it projects the
  pages written so far over the rest, and fails with the sizes when that
  would leave less than 512 MB free.

**Fixes**

- `capture` freezes running animations before reading styles: infinite
  ones (spinners, indeterminate progress bars) pause at their start, the
  others finish. They made two captures of the same CSS differ, and
  `prefers-reduced-motion` emulation doesn't stop CSS animations.
- A failed page stops every tab from taking new pages, instead of the
  others running on against closed views.
- The CLI prints system errors (`ENOSPC`, `EACCES`) in one line, not a
  stack trace, and the published CLI and `crassus/browser` ship linked
  source maps, so other stack traces point at the source.

## 0.1.3 — 2026-10-06

**Features**

- `diffSnapshots(baseDir, headDir, { examples? })` in `crassus/browser`
  compares two `capture` directories: per changed page, the element paths
  and their `{ property, before, after }` changes, plus every change grouped
  by `(property, before -> after)` with a count, the pages it's on and the
  first few paths, so a systematic change reads as one line. Files and
  element paths on one side only are listed, not diffed. It reproduces
  carbon-components-svelte's `cascade-snapshot.ts diff` groups, except that
  a property only head records (its stylesheets started declaring it) is a
  change from `null` too.
- `viewports` on `capture` and `runUsage`: every page at each size. With
  more than one, capture files are `<name>.<theme>.<W>x<H>.json`; with one
  (the default, still `width` × `height` or 1280 × 900) names don't change.
  `runUsage` aggregates them, so a declaration that wins at any viewport has
  won, and `min-width`/`max-width` rules out of range at one size stop
  reading as never matched.
- `readySelector` (and `readyTimeoutMs`, default 5000) on `capture` and
  `runUsage`: waits after load until the selector matches, before
  `settleMs`. A page that never matches is still read and returned in
  `notReady` (also in `usage.json`) instead of throwing.
- `usage.json`'s `summary` has a `viewports` count, and the file now lists
  the dead declarations and fold candidates in full (`deadInFixtures`,
  `foldCandidates`) beside the `dead` and `fold` counts.
- `themeAttribute` on `capture` and `runUsage`: the `<html>` attribute a
  theme is set as (default `theme`; `null` for none).
- CLI: `crassus capture <dir>` (and `--base <ref>`, in a worktree),
  `crassus snapshot-diff <base> <head>` and `crassus usage`, over the
  fixture pages in a new `browser` block of `crassus.config.ts`: the
  fixture directory and the command that builds it, themes, the theme
  attribute, `sheetMarker`, viewports and `readySelector`. Flags override
  it: `--only`, `--themes`, `--viewport` (repeatable), `--no-states`,
  `--engine`, `--matcher`, `--concurrency`, `--url` (a running server) and
  `--out`. `snapshot-diff` prints changes grouped by
  `property: before -> after` (or `--format json`) and exits 1 on any
  difference. `usage` writes `usage.json` and a `report.md` (dead in
  fixtures with what each lost to, fold candidates, never-matched rules,
  each by size, under the run's evidence bounds) and always exits 0.

- `diff`'s size line names the Bun version that minified it; the README
  says to budget size on your own build output.

- `fixEntries` in `crassus.config.ts`: entries `dead --fix` proves its
  edits against beside the ones `compile` builds by default, requested
  with `compile(root, { entries })`. A source line is only deleted when
  everything it produces is dead in all of them. Without it, a fix in a
  Sass partial prints which entries the proof covered.

- `--summary <file>` on `dead`, `diff` and `snapshot-diff` appends the
  human report to a file (fenced, without color) while `--format` controls
  stdout, so one CI run gives both annotations and a job summary. It's cut
  at a line, with a note, to fit GitHub's 1 MiB step summary with what's
  already there. Exit codes don't change.

**Fixes**

- Chrome pages get exactly the requested viewport. Chrome's window size
  includes its own UI, so with the system Chrome (new headless) a 1280 × 900
  capture or usage run saw a 1280 × 813 page; only Playwright's
  `chrome-headless-shell` was exact.

## 0.1.2 — 2026-10-06

**Features**

- `SHORTHANDS` is exported from `crassus`: each shorthand (or legacy alias)
  and the longhands it sets, generated from Chrome's CSSOM, the table
  `deadDeclarations` and the usage engines already use. A usage driver of
  its own can expand a shorthand CDP matched without `longhandProperties`
  (`padding: var(--a) 2px`) with `SHORTHANDS[name]?.includes(longhand)`.
  Compared with carbon-components-svelte's 16-entry table, it adds 103
  shorthands (`padding-inline`, `gap`, `grid-*`, `font`, `text-decoration`
  and experimental ones such as `rule-*`) and, among the 16,
  `transition-behavior`, `background-position-x`/`-y` and `border-image-*`.
  It also spells `inset-block`, `margin-block` and `padding-block` with
  logical longhands (`margin-block-start`), as CDP lists them, where that
  table had physical ones (`margin-top`): it left those shorthands
  unexpanded, or took another shorthand's longhands in the same rule.

## 0.1.1 — 2026-10-06

**Features**

- `canonicalSelector(text)` and `canonicalContext(name, prelude)` are
  exported from `crassus`. They spell a selector, and one `@name prelude`,
  as `Rule.selector` and `Rule.context` do, whatever spacing the sheet or a
  browser used. A usage driver of its own can key CDP's matched rules to
  `parseRules` without a second CSS parser: a selector's
  `selectorList.selectors[i].text`, `media[].text`, `supports[].text` and a
  container query's `conditionText`. They are the functions the CDP engine
  already called, `normalizeSelector` and `contextOf`, renamed.
  `canonicalSelector` parses the text and serializes it. Quotes stay as
  written, as CDP reports them. A nested rule's selector in a `Rule` is
  already resolved against its parent, so the two agree only once the text
  is resolved the same way. `canonicalContext` returns `@name` plus the
  prelude. `@media`, `@supports`, `@container` and `@scope` get the one
  condition spelling below; `@media` is lowercased, as Chrome serializes
  it, and a container name and `selector()` stay case-sensitive. A rule's
  own contexts join with `" / "`, outermost first. On the bench corpora,
  `canonicalSelector` spells every selector css-tree reads, keyframe steps
  aside, as `Rule.selector` does once both sides use the same quotes.

**Fixes**

- `Rule.context` and `Rule.scope` have one spelling per condition. The
  prelude is collapsed as a value is, then a space is inserted between `)`
  and a keyword (`(a:b)and (c:d)` and `(a:b) and (c:d)` are both
  `(a:b) and (c:d)`) and taken out from around a range operator
  (`(width >= 42rem)` and `(width>=42rem)` are both `(width>=42rem)`).
  `@media` is lowercased. A string, an escape, a space that separates `>`
  from `=` (`(width > = 1px)` stays `(width> =1px)`), and a function token
  such as `and(` keep their spelling. The CDP usage engine reads Chrome's
  serialization, which spaces both a keyword and a range operator, so a
  rule under a minified query no longer shows as never matched. `diff` no
  longer reports a context move when only that spacing changed. Reports and
  JSON use the new spelling. On the bench corpora this respells 9
  `@carbon/styles` contexts (`(width <= 11rem)` to `(width<=11rem)`) and 6
  in Primer (`(min-width:768px)and (...)` to `(min-width:768px) and (...)`).

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
