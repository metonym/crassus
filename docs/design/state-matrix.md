# Design: the state and data matrix

Status: design, not implemented (2026-10-11).

crassus checks how the cascade changes between two builds, on the default
render of each fixture page, in each theme, viewport and forced state. This
design extends that to the full matrix: component variants, real data,
environments and JS-driven states. At each point it checks invariants that
need no baseline, and a failure is shrunk to a minimal repro.

It is built from parts crassus already has. Where it makes a claim about cost
or noise, the claim is measured on carbon-components-svelte's fixtures (124
pages at `5198d984e`), with scratch probes described under
[Evidence behind this design](#evidence-behind-this-design).

## Goals and non-goals

Goals:

- Reach states the default render doesn't: `size`/`kind` variants, invalid
  and skeleton states, long and bidi text, empty and huge lists, open menus,
  forced colors, RTL, 200% zoom.
- Make each point pass or fail on its own (invariants), so a first run needs
  no baseline and an existing bug shows up without a change to compare
  against.
- Keep the matrix small with covering arrays and impact scoping. Fit the
  resource limits (concurrency ≤ cores/2, backoff under load, disk
  projected before writing).
- Keep every failure actionable: a change card with the exact matrix row, the
  event steps, a shrunk repro and the rule that decided the value.

Non-goals:

- Not a functional test runner. An invariant checks rendering (geometry,
  color, motion, focus), never behavior such as "Escape closes the menu".
  The crawl fires events only to reach states.
- Not a screen-reader audit. Focus order, names and roles belong to axe or
  the component's own tests.
- Zero runtime dependencies stays. IPOG, generators, shrinking, WCAG
  contrast and the crawl are written here, as ddmin and CIEDE2000 were.

## What already exists

| Need                                                                                                            | Already in crassus                                                     |
| :-------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------- |
| Pages per theme and viewport, attribute set before first paint                                                  | `pageJobs`, `serveFixtures` (`?cr-attr=&cr-value=`)                    |
| Tab pool, backoff under load, disk projection                                                                   | `runPool`, `checkDisk`                                                 |
| Forced `:hover`/`:focus`/`:active`, only where reachable and only where a rule uses them                        | `capturePage`, `stateTriggers`, `statePaths`                           |
| Whether a change can be seen: hidden, clipped, off the page, under `opacity: 0`, text in its background's color | `fold.ts` reasons, `--cr-hidden`                                       |
| Pixels: one screenshot per state, PNG decode, CIEDE2000                                                         | `png.ts`, `color.ts`, `combine`                                        |
| Which token a property follows                                                                                  | `traceTokens`, `diffTokens`                                            |
| Which pages a rule can reach                                                                                    | `pageIndex`, `changedRules`, `relaxSelector`                           |
| Minimizing a failing input                                                                                      | `ddmin` (`crassus reduce`)                                             |
| Cards, report, approvals, repro                                                                                 | `buildCards`, `crassus/report@1`, `crassus.approved.json`, `reproHtml` |
| An element built for a selector                                                                                 | `synthesize` (`diff --confirm`)                                        |
| Which declarations the fixtures exercise                                                                        | `mutationCoverage` (`crassus coverage`)                                |

What's new: factors and a fixture protocol, a covering-array generator, data
generators with shrinking, a real-event crawl, the invariants, and one
report.

## Factors

A factor is one dimension with a finite list of values, each with a name. The
first value is the default, and shrinking moves toward it. Factors differ in
what changing them costs, and that decides where they go:

| Kind        | Examples                                                                                                                      | Changed by         | Cost                                                    |
| :---------- | :---------------------------------------------------------------------------------------------------------------------------- | :----------------- | :------------------------------------------------------ |
| Environment | theme, viewport, zoom, `dir`, `forced-colors`, `prefers-contrast`, `prefers-reduced-motion`, `hover`/`pointer`, font fallback | a page load        | a load: about 2.4 tab-seconds per page measured (below) |
| Component   | `kind`, `size`, `disabled`, `invalid`, `skeleton`, `icon`, `open`                                                             | a mount            | a re-render, no load                                    |
| Data        | text, numbers, list length, missing optional props                                                                            | a mount            | a re-render                                             |
| CSS state   | hover, focus, focus-visible, active, focus-within                                                                             | forced in the page | already in every capture: not a factor                  |
| Interaction | event sequences                                                                                                               | the crawl          | per event                                               |

CSS states stay out of the covering array. Forcing them costs nothing extra
per row, because one capture already reads every reachable state of every
element (see the state index in `capturePage`). They're exhaustive within each row, so a covering array over
the other factors is covered in every state for free. That is stronger than
pairwise.

### Declaring factors

The library declares component and data factors per fixture in
`crassus.config.ts`, so its fixtures stay ordinary pages:

```ts
matrix: {
  strength: 2,
  // 3-way where faults cluster: the forced-colors bugs carbon fixed were all
  // "this state in forced colors".
  relations: [["theme", "forced-colors", "selected"]],
  environment: {
    theme: ["white", "g10", "g90", "g100"],
    viewport: ["1280x900", "320x640", "1600x900"],
    zoom: [1, 2, 4],
    dir: ["ltr", "rtl"],
    "forced-colors": ["none", "active"],
    "prefers-reduced-motion": ["reduce", "no-preference"],
  },
  fixtures: {
    button: {
      kind: ["primary", "secondary", "tertiary", "ghost", "danger"],
      size: ["default", "small", "field", "lg", "xl"],
      icon: ["none", "icon", "icon-only"],
      disabled: [false, true],
      skeleton: [false, true],
      label: text(),
    },
  },
  constraints: [
    (r) => !(r.skeleton && r.disabled),
    (r) => r.icon !== "icon-only" || r.label.length <= 1,
  ],
}
```

`text()`, `count()` and `number()` are crassus's data generators (below).
Constraints are plain predicates over a partial row. IPOG asks them about
partial rows, so a constraint must return true when the factors it reads
aren't set yet.

### The fixture protocol

A fixture page that takes rows defines one global:

```js
window.crassus = {
  // Renders `row` into `target` and resolves once the DOM has settled.
  // Returns the element the invariants scope to.
  mount: async (row, target) => Element,
  unmount: async (target) => void,
};
```

crassus mounts several rows per page load, each in its own `<section>`, and
re-mounts in place while shrinking, so a shrink step costs a re-render, not
a load. A Svelte, React or Vue fixture writes this in a few lines (`mount`
from `svelte`, `createRoot`, `createApp`), and crassus ships none of it.

Fixtures without the protocol still get the matrix's zero-setup tier:
environment rows, forced states, the crawl and the invariants, on the page as
it renders. Text data then comes from rewriting the page's own text nodes
(a long string, RTL, CJK) before reading. That reaches the clipping and
wrapping bugs without fixture code, but not list sizes or props, and a
framework that re-renders can undo it (crassus reads before the next frame
and marks the row "perturbed").

### Environment factors

| Factor                                                                                | How                                                                                                                             | Engines |
| :------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------ | :------ |
| theme                                                                                 | `?cr-attr=theme` (exists)                                                                                                       | both    |
| viewport                                                                              | `View.resize` (exists)                                                                                                          | both    |
| zoom 200%, 400%                                                                       | `Emulation.setDeviceMetricsOverride` with width ÷ zoom and `deviceScaleFactor` × zoom (WCAG reflow: 1280 at 400% is 320 CSS px) | Chrome  |
| `dir`                                                                                 | a second attribute through the same query (`cr-attr=dir`)                                                                       | both    |
| `forced-colors`, `prefers-contrast`, `prefers-color-scheme`, `prefers-reduced-motion` | `Emulation.setEmulatedMedia` features                                                                                           | Chrome  |
| `hover: none` / `pointer: coarse`                                                     | `Emulation.setEmitTouchEventsForMouse` plus media features                                                                      | Chrome  |
| font fallback                                                                         | `serveFixtures` answers font requests with 404                                                                                  | both    |

Every Chrome load emulates `prefers-reduced-motion: reduce` today
(`view.ts`), so crassus never captures what most users see while animations
run. The motion factor makes that explicit, and its default stays `reduce`.
On WebKit, a factor with no means of emulation leaves its rows out and the
report says so. It doesn't fold them into the default value.

carbon's `89b8a03b9` ("guard Tabs hover rules against touch devices") is the
`hover: none` case: a hover style that sticks after a tap.

### Data generators

Each generator lists named levels, so the covering array treats them as
values. Each draws its concrete value from a seeded choice sequence, so
shrinking can make it simpler (see Shrinking).

| Generator      | Levels                                                                                                                                                                    |
| :------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `text()`       | empty, one character, typical, 200+ characters with spaces, one unbroken 80-character word, RTL (Hebrew/Arabic), bidi mix, CJK, emoji with ZWJ sequences, combining marks |
| `number()`     | 0, negative, 10^12, a decimal, localized (`1.234,5`)                                                                                                                      |
| `count()`      | 0, 1, typical (5), many (50), huge (10,000, rendered only where the component virtualizes; otherwise left to the crawl budget)                                            |
| optional props | present, missing                                                                                                                                                          |

The 10,000-item level comes with a cost check. A row whose mount takes more
than `matrix.mountBudgetMs` (default 2,000) is reported as slow and not
read, rather than holding the tab.

## Covering arrays (IPOG)

The full product of a component's factors is far too large. The Button
model above has 1,290,240 combinations (423,360 valid under its
constraints). A pairwise covering array includes every value pair of every
two factors in at least one row. Kuhn et al.'s fault-interaction studies put
most faults within 2 or 3 interacting factors.

The generator is IPOG (Lei et al., 2007):

1. Start with every t-tuple of the first t factors.
2. Add one factor at a time, horizontally: give each existing row the value
   that covers the most uncovered tuples involving the new factor.
3. Then vertically: place each remaining tuple in a row whose other
   positions are free, or add a row.
4. Fill the remaining blanks with the first value the constraints allow.

On top of that:

- **Constraints.** A tuple no valid row can hold, such as a skeleton in
  focus or text on an icon-only button, is never required. A row is checked
  against every constraint before it is accepted.
- **Mixed strength.** `relations` lists factor groups covered at strength 3
  (or more) within a pairwise array.
- **Seeds.** The all-defaults row and each fixture's own render are always
  rows, so the matrix includes what crassus captures today.
- **Stable rows.** The output is deterministic: factors and values in
  declaration order, ties broken by index. Adding one value adds rows
  without reshuffling the others, so a row's id
  (`shortHash(fixture + row)`) and its approvals survive.

Measured with a scratch IPOG on the Button model (12 factors, including
`state`):

| Strength                                              |                      Rows | Generation |
| :---------------------------------------------------- | ------------------------: | ---------: |
| Pairwise                                              |                        61 |       4 ms |
| Pairwise, plus 3-way on state × theme × forced-colors |                        60 |       3 ms |
| 3-way                                                 |                       324 |      32 ms |
| Full product                                          | 1,290,240 (423,360 valid) |          — |

Every array above was checked: each feasible tuple is covered and no row
breaks a constraint. 61 rows is close to the floor. `kind` × `text` alone
needs 7 × 8 = 56 rows.

### From rows to page loads

Rows are grouped by their environment values, and each group is one page
load that mounts its rows side by side. With the environment factors first
in IPOG's order, the Button array (without `state`, which forcing covers) is
63 rows across 24 distinct environments, so 24 loads instead of 63. The
environment factors alone need 13 pairwise rows (of 96).

At the measured capture rate (2.4 tab-seconds per page load with forced
states), the Button's 24 loads take about 58 tab-seconds, roughly 15 s at 4
tabs. That is an estimate from the rate, and phase 1 measures it.

### Impact scoping

On a stylesheet change (`compare`/`bisect --matrix`), the page index `compare` builds works
per row: a row whose mounted elements no changed rule's relaxed selector
matches isn't loaded. The index is keyed by the fixture's content hash and
the row id.

## Forced states and the real-event crawl

There are two passes, and each catches what the other can't:

- **Forced** (exists): CDP `CSS.forcePseudoState` on each element a
  state-using rule names. It's cheap, reaches every CSS state, and is
  already limited to states a user can reach (no focus on a disabled button,
  nothing under `inert`).
- **Crawl** (new): real input events through CDP `Input.dispatchMouseEvent`,
  `dispatchKeyEvent` and `dispatchTouchEvent`. It reaches what's driven by
  JS: `--active` and `--open` classes, `aria-expanded` menus, validation
  messages and focus moved by script.

### The model

The crawl walks the states the page can reach, breadth first:

- **Abstract state.** A hash of the mounted subtree's structure: tags, class
  sets, `aria-expanded`/`selected`/`checked`/`invalid`/`pressed`, `open`,
  `disabled`, plus the focused element's path. Text and inline geometry are
  left out, so a moving caret or a timer doesn't read as a new state.
  Crawljax dedupes by a DOM abstraction for the same reason.
- **Events.** On each visible, enabled element the interactive selector
  matches (`INTERACTIVE`, the same as forcing): pointer enter, down and up
  (a click), and drag-out (down, then up outside). From the focused
  element: Tab, Shift+Tab, the arrows, Enter, Space, Escape, Home and End.
  With `pointer: coarse`, a tap.
- **Settle.** After each event, wait one animation frame, then for running
  transitions and animations to finish, which `capture` already does. A
  "fast" variant fires the next event before the settle, which is how focus
  moving in or out during a transition is reached.
- **Reset.** To get back to a known state, replay the path from a fresh
  mount (protocol fixtures) or a fresh load. The crawl never trusts an
  "undo" event.
- **Budget.** At most `crawl.depth` events deep (default 3) and
  `crawl.events` per row (default 200). Each new abstract state is captured
  once, with its forced states read as in any capture.

The probe found 1,936 enabled, visible targets on 246 page loads, about 8
per page. With roughly 10 events per target, depth 1 is about 80 events per
page, and 200 covers the first new states of a typical fixture. The cost per
event isn't measured yet; phase 3 measures it before choosing the defaults.

### Cross-checking the passes

- A state the crawl reaches that forcing didn't capture is **JS-driven**,
  and its records join the capture under `path@crawl:<steps>`.
- An element the crawl focuses or hovers whose forced read differs from the
  real one shows forcing being unfaithful there: `:focus-visible`
  heuristics, `:hover` on a parent the pointer passed through, or the 0.2.0
  note that "the last reachable state wins" where an element sits under
  several forced ones. The report lists these. They tell whether forced
  records can be trusted for that component.

The crawl is Chrome-only: it needs CDP's `Input` domain, which crassus has
only on Chrome, and synthesized DOM events (`isTrusted: false`) don't set
`:hover` or `:active`.

## Invariants

Each invariant is a pass/fail rule with a measured value and a threshold,
checked at every point: each row, in each forced state and each crawled
state. The noise matters as much as the rule. A first probe of three of them
on the fixtures, run naively, found mostly false positives for contrast and
clipping, and the rules below are shaped by what it found.

Applied to every invariant:

1. **The visibility rung runs first.** A failure on something no user sees
   isn't one. Of the probe's 264 "clipped text" hits, 232 were
   screen-reader-only text (`bx--visually-hidden`, hidden `bx--label`,
   `bx--assistive-text`) that `capture`'s invisibility reasons already mark invisible.
2. **The scope is library-decided elements.** An element counts only if the
   value the invariant reads was decided by a library rule (`sheetMarker`,
   from the cascade crassus already walks for `--explain`). The probe's 32
   contrast hits included 15 on `consumer-override`, a fixture that sets its
   own colors on purpose. Library text on a backdrop no library rule
   painted is reported as a fixture backdrop, not a contrast failure: 4
   more hits were on pages whose body background stays white in g100.
3. **Disabled means the control's state.** WCAG exempts inactive components
   and their labels, and the disabled state usually sits on the `<input>`,
   not on its label text. The exemption follows `label[for]`, an enclosing
   `<label>` and `aria-labelledby`. 12 of the 32 contrast hits were labels
   of disabled inputs and toggles.
4. **Pixels confirm.** Where the DOM can't give the answer (a background
   image or gradient, a background drawn by `::before`, an ancestor
   positioned elsewhere), the invariant reads the state's screenshot crop.
   If that can't decide either, it reports "can't tell", never pass or
   fail.
5. **Approvals cover intended exceptions.** An invariant failure is a card,
   and `crassus approve` records it with its measured value. The same
   failure at a worse value isn't approved.

| Invariant              | Rule                                                                                                                                                                                                                                                | Computed from                                                                                                                                      | Golden case in carbon                                                                                                                                                                                                      |
| :--------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focus visible          | Under keyboard focus, every reachable focusable element changes pixels around itself, and the change has ≥ 3:1 contrast against the unfocused pixels (WCAG 2.4.11, 2.4.13)                                                                          | The rest vs `@focus` crops (one screenshot per state, as `compare --visual` takes), differing pixels, WCAG contrast per pixel pair                 | `83ca23bda`: the Toggle's focus ring was a `box-shadow`, which forced colors drop, so focus was invisible in High Contrast                                                                                                 |
| Text contrast          | ≥ 4.5:1, or 3:1 for text ≥ 24px or ≥ 18.66px bold                                                                                                                                                                                                   | Text color, ancestor opacity and alpha composed over the resolved backdrop (`fold.ts` `backdrop`); pixels when uncertain                           | Probe: 32 hits before the rules above, 1 left to check by pixels (`bx--header__action-text`, 1.39:1 by DOM ancestors)                                                                                                      |
| No unintended clipping | Overflowing text either wraps, or ends in an ellipsis with the full text available (`title`, a tooltip, `aria-label`). No focus ring or popover cut by an `overflow` ancestor                                                                       | `scrollWidth > clientWidth` under `overflow: hidden`/`clip`; outline and shadow extents against each overflow ancestor's clip rect                 | `7be4df838`: a long file name ended in an ellipsis with no way to read it (needs the data factor). `5410180e5`, `6c37e458f`: menus clipped custom labels                                                                   |
| Target size            | Interactive targets are at least 24 × 24 CSS px, or a 24px circle on their center clears every other target (WCAG 2.5.8), or the target sits inline in text                                                                                         | The click target's box. For a visually hidden input that's its `<label>`. The probe's 12 1×1 hits were all native inputs whose label is the target | Probe: 32 `bx--tooltip__trigger` buttons at 16 × 16 with another target within 12px                                                                                                                                        |
| Layout stability       | Entering a state changes neither the element's own size nor its siblings' positions by ≥ 0.5px                                                                                                                                                      | `width`/`height` of `path` vs `path@state` in the snapshot (already recorded), plus sibling offsets (new: `--cr-box`)                              | `909847958`: a text `HeaderAction`'s border grew from 1px to 2px on focus, widening the button                                                                                                                             |
| Theme contract         | A property that follows a token in the reference theme follows it in every theme. Under `forced-colors: active`, state pairs (selected/unselected, checked, pressed, focus/rest) still differ by ΔE ≥ 1 over at least a perimeter's worth of pixels | Token tracing (`--tokens`) per theme row (`token-detached` in any theme fails). `--visual` crops and CIEDE2000 for the state pairs                 | `919f54e96` content-switcher selected, `b55cd46c2` toggle-button-group pressed, `a7f578b0a` tree-view selected and disabled, `94de480c4` header nav, `6ac646451` progress bar fill: each looked identical in forced colors |
| Motion                 | Under `prefers-reduced-motion: reduce`, after settling, no running animations or transitions except opacity fades (configurable)                                                                                                                    | `document.getAnimations()` with each animation's animated properties; non-zero `transition-duration` on properties other than `opacity`            | —                                                                                                                                                                                                                          |
| RTL mirror             | Under `dir=rtl`, each box sits at its LTR position mirrored inside its containing block (`x' = W − x − w`, ±1px), and directional icons flip unless marked as not directional                                                                       | LTR and RTL rows of the same mount. Icons from a configured selector (`matrix.directionalIcons`) and their computed `transform`                    | `5993a2ed4`: badge-indicator kept `right: 0` beside `margin-inline-end`, so in RTL the badge stayed right while its margin flipped                                                                                         |

Layout stability over the capture taken for this design (white, 1280 × 900,
forced states): 22 size changes in 11,903 element-state pairs. All were
intended: the rail side-nav expanding on focus (`48px → 256px`) and the
slider thumb swapping its icon. Those become approvals on the first run. The
rule's noise is low enough to fail by default.

Contrast and target size fail by default once rules 1–4 apply. Motion and
RTL start as warnings until a phase-5 eval measures their noise.

## Shrinking

A failure is shrunk on three axes, independently, each checking it still
fails the same way:

- **Same failure** means the same invariant, on the same element (its path
  with `nth-child` indices dropped), on the same side of the threshold.
  Without that check, shrinking slides to a different, simpler bug.
  Hypothesis guards against this the same way.
- **Row.** Move each factor to its default, one at a time, keeping each move
  that still fails. What remains is the set of factors that matter: "g100 ×
  forced-colors × selected", not a 12-factor row. This is ddmin (as in `crassus reduce`) with
  factors as the units.
- **Data.** Integrated shrinking, as in Hypothesis and fast-check. Every
  generated value is drawn from a recorded choice sequence (integers), and
  shrinking edits the sequence, not the value:
  - delete spans;
  - lower each choice toward 0;
  - sort.

  A string then gets shorter and its characters simpler. It stays RTL only
  if that's what fails. A list gets fewer items. A number moves toward 0.
  No per-type shrinkers are needed, and every shrunk value is one the
  generator could have produced.
- **Steps.** A crawl failure's event path is ddmin'd: drop events while the
  same failure still occurs at the end of the path.

Each try re-mounts in place (protocol fixtures) and reads only the failing
element, so a try costs a re-render and one style read. The default budget
is 200 tries or 30 s per failure, whichever is first. The result records
how many tries were taken and whether the budget ran out, as `crassus
reduce` does.

The 7be4df838 file name, for example, should shrink to the shortest unbroken
string that still overflows, at one viewport, with every other factor
default.

## Output

- **Schema.** `crassus matrix --json` writes `crassus/matrix@1`, a separate
  schema, so `crassus/report@1` (compare, bisect) doesn't change. Its cards
  reuse the card shape, with `kind: "invariant"`, `invariant`, `measured`,
  `threshold`, `row` (factor values), `steps` (event path), `shrunk` (row,
  data and steps, plus tries) and `decidedBy` (the rule and source line that
  set the value). When `compare --matrix` puts invariant cards in a compare
  report, that is `crassus/report@2`, under **Breaking**.
- **Change cards** get a fourth strip after base, head and diff: the matrix
  row, showing the state, theme, data and steps as text, with the shrunk row
  beside the original.
- **Repro.** `crassus repro <id>` builds the shrunk row's element in a
  page of its own with the environment applied: the `dir` and theme
  attributes, plus a note of the media features to emulate.
- **Approvals.** These go in `crassus.approved.json` as for compare cards,
  with the measured value as the approved change.
- **Coverage heatmap.** The HTML report shows a grid of components ×
  factor values: the cells run, the invariants that failed in each, and,
  from a `crassus coverage` run on the same rows, the declarations each value
  exercised. Coverage also feeds the matrix: an unmatched declaration under
  `.bx--btn--sm` names the `size: small` row that would cover it, with the element
  `diff --confirm` would synthesize as a hint when no factor value does.

## Resource limits

The matrix multiplies everything, so its limits come first:

- **Projection before running.** `crassus matrix` prints the rows, page
  loads, estimated tab-seconds (from a running per-load average, seeded with
  the doctor's measurement) and projected disk use. It refuses to start
  above `--max-loads` (default 500) unless the flag is raised.
- **Disk.** Snapshots measured at 996 KB for 124 pages, about 8 KB a page
  gzipped. Screenshots are kept only for failing cards, as crops. A
  run of 10,000 page loads is then about 80 MB of snapshots, and `checkDisk` projects
  it before writing.
- **Load.** The run uses `runPool`'s backoff (one tab while the 1-minute load
  is above the core count) and the default of half the cores, at most 4
  tabs. Shrinking runs after the matrix, one failure at a time, never next
  to it.
- **Evals.** These are one theme and one viewport unless an invariant needs
  more (RTL needs `dir`, the theme contract needs two themes and forced
  colors), and never in parallel with each other.

## Phases

Each phase ships on its own, with tests, an eval check against the golden
cases, README and changelog.

| Phase | Ships                                                                                                                                            | Eval (on carbon-components-svelte)                                                                                                  |
| :---- | :----------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Environment factors (`dir`, zoom, media features, font fallback) on `capture`/`compare`. Layout stability and focus visible on existing captures | `909847958^` fails layout stability, `909847958` passes. `83ca23bda^` fails focus visible in forced colors. Per-load cost measured  |
| 2     | `crassus/matrix@1`, IPOG with constraints and relations, the fixture protocol, data generators, row shrinking and data shrinking                 | Rows and coverage verified for each fixture model. `7be4df838^` fails clipping on a long file name and shrinks to one unbroken word |
| 3     | The crawl, and the forced-vs-real cross-check                                                                                                    | JS-driven states found per fixture. The "last reachable state wins" cases listed. Event cost measured, defaults set                 |
| 4     | Contrast, target size, theme contract (forced colors)                                                                                            | The five forced-colors fixes each fail at `^` and pass at the fix. Contrast and target noise reported against the probe's           |
| 5     | Motion, RTL, heatmap, `compare --matrix` (`crassus/report@2`)                                                                                    | `5993a2ed4^` fails RTL mirror. Motion noise measured before it can fail a run                                                       |

Golden cases that are JS fixes (`7be4df838`) need the fixtures built at
each commit. That's what `browser.fixtures.build` already runs in a base
checkout, so they cost a build each and run one at a time.

## Open questions

- **Per-element or per-row thresholds.** The visibility rung is
  per-element, while WCAG's focus appearance (2.4.13) is an area measure.
  The proposal starts per-element and adds the area measure behind a flag
  once phase 1's numbers are in.
- **The forced-colors reference.** Distinguishable is measured against the
  forced palette Chrome emulates (`Canvas`, `Highlight`). Windows' real
  palettes vary. Running two palettes, through `prefers-color-scheme` under
  forced colors, may be worth it.
- **Fixture-authored content.** The library-decided rule removes most fixture
  noise. A fixture that's deliberately off-spec (`consumer-override`) may
  want an opt-out in config instead.

## Evidence behind this design

Run on carbon-components-svelte `5198d984e`, with fixtures built by its
config, in Chrome (`chrome-headless-shell`), 4 tabs:

- **Capture cost and size.** `crassus capture --themes white --viewport
  1280x900`: 124 pages in 75.6 s (2.4 tab-seconds per page with forced
  states), 996 KB of snapshots.
- **Covering arrays.** A scratch IPOG (about 100 lines, with constraints,
  relations and a coverage checker) on the Button model in this document
  gave the row counts in the table above.
- **Invariant probe.** One page script for text contrast (WCAG relative
  luminance, alpha composed over DOM ancestors), target size (24px with the
  spacing and inline exceptions) and clipped text, run over 246 loads
  (white and g100, 1280 × 900):
  - 3,458 text elements: 32 below the contrast threshold (12 disabled
    labels, 15 on `consumer-override`, 4 on an unthemed page background,
    1 to check by pixels);
  - 1,936 targets: 56 under 24 × 24 without spacing (32 tooltip triggers,
    12 hidden native inputs, 2 more tooltip triggers, 4 definition
    tooltips, 4 links and 2 legends);
  - 264 clipped texts: 232 screen-reader-only, 26 ellipsized without a
    title (`bx--side-nav__link-text` and others).
- **Layout stability** over the capture above: 22 size changes in 11,903
  element-state pairs, all intended.

The probes are scratch scripts and aren't shipped; phase 1 turns them into
`eval/carbon/matrix.ts`.

## References

- Lei, Kacker, Kuhn, Okun, Lawrence, "IPOG: A General Strategy for T-Way
  Software Testing", ECBS 2007.
- Kuhn, Wallace, Gallo, "Software Fault Interactions and Implications for
  Software Testing", IEEE TSE 2004.
- Mesbah, van Deursen, Lenselink, "Crawling AJAX-Based Web Applications
  through Dynamic Analysis of User Interface State Changes", ACM TWEB 2012.
- MacIver, Donaldson, "Test-Case Reduction via Test-Case Generation:
  Insights from the Hypothesis Reducer", ECOOP 2020 (integrated shrinking).
- fast-check's documentation on shrinking.
- WCAG 2.2: 1.4.3 Contrast, 1.4.10 Reflow, 2.4.11 and 2.4.13 Focus,
  2.5.8 Target Size (Minimum).
