// `crassus coverage`: mutation coverage of the library stylesheet over the
// fixtures, per declaration at its source line, per file and component.
import type { RuleCoverage } from "../browser/coverage";
import { alignRules, libraryRules } from "../core/align";
import type { Config } from "../core/config";
import { defaultComponentOf } from "../core/diff";
import { locator } from "../core/parse";
import { SHORTHANDS } from "../core/shorthands";
import { synthesize, type Tree } from "../core/synth";
import { pushTo } from "../core/util";
import {
  type BrowserFlags,
  EMULATE,
  fixturePages,
  needMarker,
  pick,
  reportNotReady,
  settings,
  throttled,
} from "./browser";
import type { Io } from "./main";
import { stylesheets, UsageError } from "./project";
import { seconds } from "./report";
import { locateIn } from "./sources";

/**
 * `covered`: removing it changes a value the fixtures render. `decides
 * nothing`: its rule styles an element, but no value depends on it (always
 * overridden, or equal to what wins without it). `unmatched`: its rule
 * styles no element in any page, theme, viewport and state run.
 * `condition never holds`: its `@media` or `@supports` never held there
 * (another breakpoint, print, forced colors).
 */
type CoverageStatus =
  | "covered"
  | "decides nothing"
  | "unmatched"
  | "condition never holds";

interface DeclarationCoverage {
  status: CoverageStatus;
  selector: string;
  property: string;
  value: string;
  file?: string;
  line?: number;
  component: string;
  /** For an unmatched rule: an element it would style. */
  example?: string;
}

const CLASS_RE = /\.(-?[_a-zA-Z][\w-]*)/;

const html = ([tag, attrs, children]: Tree): string => {
  const a = Object.entries(attrs)
    .filter(([k]) => k !== "data-cr-target")
    .map(([k, v]) => (v ? ` ${k}="${v}"` : ` ${k}`))
    .join("");
  return `<${tag}${a}>${children.map(html).join("")}</${tag}>`;
};

/** Maps the engine's rules back to the source declarations they hold. */
function declarationCoverage(
  rules: RuleCoverage[],
  css: string,
  locate: (offset: number) => { file?: string; line?: number },
  componentOf: (cls: string) => string,
): DeclarationCoverage[] {
  const parsed = libraryRules(css);
  const aligned = alignRules(
    rules.map((r) => r.selector),
    parsed,
  );
  const out: DeclarationCoverage[] = [];
  rules.forEach((rule, i) => {
    const source = aligned[i];
    if (!source) return;
    const cls = CLASS_RE.exec(rule.selector)?.[1];
    const component = cls ? componentOf(cls) : "(element selectors)";
    const covered = new Set(rule.covered);
    let example: string | undefined;
    for (const d of source.decls) {
      const property = d.property.toLowerCase();
      const longhands = SHORTHANDS[property] ?? [property];
      const status: CoverageStatus = !rule.held
        ? "condition never holds"
        : rule.pages.length
          ? longhands.some((l) => covered.has(l))
            ? "covered"
            : "decides nothing"
          : "unmatched";
      if (status === "unmatched" && example === undefined) {
        const first = source.selectors[0]?.canon ?? rule.selector;
        const tree = synthesize(first, first)[0];
        example = tree ? tree[2][1][2].map(html).join("") : "";
      }
      out.push({
        status,
        selector: rule.selector,
        property: d.property,
        value: d.raw,
        ...locate(d.start),
        component,
        ...(status === "unmatched" && example && { example }),
      });
    }
  });
  return out;
}

const pct = (n: number, of: number) =>
  of ? `${((100 * n) / of).toFixed(1)}%` : "-";

/** `crassus coverage`. Always exit 0: evidence, bounded by the fixtures. */
export async function coverageCommand(opts: {
  config: Config;
  flags: BrowserFlags;
  entry: string[];
  format: "human" | "json";
  io: Io;
}): Promise<number> {
  const { io, flags } = opts;
  const { cwd } = io;
  const { browser, pages, throttle } = settings(opts.config, flags, io);
  const marker = needMarker(browser, "coverage");
  if (flags.url)
    throw new UsageError("coverage serves the fixtures: drop --url");
  const sheet = pick(
    await stylesheets(cwd, opts.config, opts.entry),
    opts.entry,
  );
  const { path, fixtures } = await fixturePages(cwd, browser, flags);
  const { mutationCoverage } = await import("../browser/coverage");
  const r = await mutationCoverage({
    ...pages,
    dir: path,
    fixtures,
    sheetMarker: marker,
    css: sheet.css,
    emulate: EMULATE[pages.engine],
    settleMs: browser.settleMs,
  });
  const at = locator(sheet.css);
  const locate = locateIn(sheet);
  const componentOf = opts.config.componentOf ?? defaultComponentOf;
  const decls = declarationCoverage(
    r.rules,
    sheet.css,
    (offset) => {
      const loc = locate(at(offset));
      return loc ? { file: loc.file, line: loc.line } : {};
    },
    componentOf,
  );
  const count = (s: CoverageStatus, list = decls) =>
    list.filter((d) => d.status === s).length;
  const by = (key: (d: DeclarationCoverage) => string) => {
    const m = new Map<string, DeclarationCoverage[]>();
    for (const d of decls) pushTo(m, key(d), d);
    return [...m]
      .map(([name, list]) => ({
        name,
        total: list.length,
        covered: count("covered", list),
        unmatched: count("unmatched", list),
        nothing: count("decides nothing", list),
        conditions: count("condition never holds", list),
      }))
      .sort((a, b) => b.total - b.covered - (a.total - a.covered));
  };
  const files = by((d) => d.file ?? sheet.name);
  const components = by((d) => d.component);
  const summary = {
    declarations: decls.length,
    covered: count("covered"),
    decidesNothing: count("decides nothing"),
    unmatched: count("unmatched"),
    conditionNeverHolds: count("condition never holds"),
  };
  if (opts.format === "json") {
    io.out(
      JSON.stringify(
        {
          schema: 1,
          command: "coverage",
          claim: "evidence",
          pages: r.pages,
          ms: r.ms,
          notReady: r.notReady,
          summary,
          files,
          components,
          declarations: decls,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const row = (x: (typeof files)[number]) =>
    `  ${pct(x.covered, x.total).padStart(6)}  ${String(x.covered).padStart(5)} of ${String(x.total).padEnd(5)} ${x.name}  (${x.unmatched} unmatched, ${x.nothing} decide nothing, ${x.conditions} under a condition that never held)`;
  const uncovered = decls.filter((d) => d.status !== "covered");
  io.out(
    [
      `crassus: ${summary.covered} of ${summary.declarations} declarations decide a value the fixtures render: ${pct(summary.covered, summary.declarations)} (${r.pages} page(s), ${seconds(r.ms)}${throttled(throttle)}; evidence, bounded by the fixtures, themes, viewports and states run)`,
      `  ${summary.unmatched} in rules no fixture element matches; ${summary.decidesNothing} in rules that match, deciding nothing (overridden, or the same as what wins without them); ${summary.conditionNeverHolds} under @media or @supports that never held`,
      "  Markup the fixtures only show after an interaction (an open menu, a modal) reads as unmatched: it isn't on the page they load.",
      "",
      "Least covered files:",
      ...files.slice(0, 12).map(row),
      "",
      "Least covered components:",
      ...components.slice(0, 12).map(row),
      "",
      `Uncovered (first 25 of ${uncovered.length}; --format json lists them all):`,
      ...uncovered
        .slice(0, 25)
        .map(
          (d) =>
            `  ${d.file ? `${d.file}:${d.line}  ` : ""}${d.selector} { ${d.property}: ${d.value} }  ${d.status}${d.example ? `; an element it styles: ${d.example}` : ""}`,
        ),
    ].join("\n"),
  );
  reportNotReady(io, r.notReady, pages, "read");
  return 0;
}
