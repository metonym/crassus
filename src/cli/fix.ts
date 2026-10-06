/**
 * `crassus dead --fix`. CSS without a source map is edited in place (unless
 * the config's `build` writes it). With a map, a source declaration goes
 * when everything it produces, in every stylesheet analyzed, is dead. Every
 * edit is checked: re-analyzed, the stylesheets must have lost exactly the
 * fixed declarations.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalValue } from "../core/cascade";
import type { DeadDeclaration } from "../core/overrides";
import {
  locator as lineIndex,
  lineStarts,
  type Node,
  parseStylesheet,
} from "../core/parse";
import { placeRules } from "../core/placement";
import { serialize } from "../core/selector";
import { pushTo } from "../core/util";
import type { DeadResult } from "./commands";
import {
  type Locate,
  mappedLocator,
  type Sheet,
  type SourceLocation,
} from "./sources";

interface Fixed {
  entry: string;
  /** Where it was deleted: the CSS file, or its source. */
  file: string;
  line: number;
  selector: string;
  property: string;
  value: string;
  /** What wins instead: make sure it's the value you meant. */
  by: { property: string; value: string };
}

interface Skipped {
  entry: string;
  selector: string;
  property: string;
  value: string;
  source?: SourceLocation;
  reason: string;
}

interface FixPlan {
  fixed: Fixed[];
  skipped: Skipped[];
  /** Files to write: path relative to the project root, before and after. */
  files: { file: string; before: string; after: string }[];
  /** The dead declarations the edits remove, by stylesheet. */
  removed: Map<string, DeadDeclaration[]>;
}

/** A declaration's identity for the before/after check. */
const declKey = (
  where: { context: string; layer: string; scope: string },
  selector: string,
  property: string,
  value: string,
) =>
  `${where.context}\0${where.layer}\0${where.scope}\0${selector}\0${property}\0${value}`;

/** Every style declaration of a stylesheet, as a multiset of declKeys. */
function declarationsOf(css: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of placeRules(parseStylesheet(css))) {
    if (p.keyframes) continue;
    const selector = p.selectors.map((s) => serialize(s.complex)).join(",");
    for (const d of p.decls) {
      const property = d.property.startsWith("--")
        ? d.property
        : d.property.toLowerCase();
      const key = declKey(
        { context: p.context, layer: p.layer.name, scope: p.scope },
        selector,
        property,
        canonicalValue(d.raw, false, d.property),
      );
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/** The multiset `before` minus the fixed declarations. */
function expectedAfter(
  before: Map<string, number>,
  dead: DeadDeclaration[],
): Map<string, number> {
  const out = new Map(before);
  for (const d of dead) {
    const key = declKey(d, d.selector, d.property, d.value);
    out.set(key, (out.get(key) ?? 0) - 1);
    if (out.get(key) === 0) out.delete(key);
  }
  return out;
}

const sameCounts = (a: Map<string, number>, b: Map<string, number>) =>
  a.size === b.size && [...a].every(([k, n]) => b.get(k) === n);

// ---------------------------------------------------------------------------
// Edits

interface Range {
  start: number;
  end: number;
}

const isBlank = (c: number) => c === 32 || c === 9 || c === 13;

/** A deletion widened to whole lines when nothing else is on them, else over trailing spaces. */
function widen(text: string, r: Range): Range {
  let a = r.start;
  while (a > 0 && isBlank(text.charCodeAt(a - 1))) a--;
  let b = r.end;
  while (b < text.length && isBlank(text.charCodeAt(b))) b++;
  const lineStart = a === 0 || text.charCodeAt(a - 1) === 10;
  const lineEnd = b === text.length || text.charCodeAt(b) === 10;
  if (lineStart && lineEnd)
    return { start: a, end: Math.min(text.length, b + 1) };
  return { start: r.start, end: b };
}

function apply(text: string, ranges: Range[]): string {
  const sorted = [...ranges]
    .map((r) => widen(text, r))
    .sort((x, y) => x.start - y.start);
  let out = "";
  let at = 0;
  for (const r of sorted) {
    if (r.start < at) continue; // overlaps an earlier deletion
    out += text.slice(at, r.start);
    at = r.end;
  }
  return out + text.slice(at);
}

/** A CSS declaration's range, `;` included when one follows. */
function cssRange(css: string, [start, end]: [number, number]): Range {
  let b = end;
  while (b < css.length && WS_RE.test(css[b])) b++;
  return { start, end: css[b] === ";" ? b + 1 : end };
}

// Just past a source declaration's `;`, or at its block's `}`. Knows
// strings, comments, nesting, and Sass/Less `//` comments and `#{…}`.
function statementEnd(
  text: string,
  from: number,
  lineComments: boolean,
): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      for (i++; i < text.length && text[i] !== c; i++)
        if (text[i] === "\\") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? text.length : close + 1;
    } else if (
      lineComments &&
      c === "/" &&
      text[i + 1] === "/" &&
      depth === 0
    ) {
      return i;
    } else if (c === "\\") i++;
    else if (c === "(" || c === "[" || (c === "#" && text[i + 1] === "{")) {
      depth++;
      if (c === "#") i++;
    } else if (c === ")" || c === "]" || (c === "}" && depth > 0)) depth--;
    else if (depth === 0 && c === ";") return i + 1;
    else if (depth === 0 && (c === "}" || c === "{")) return i;
  }
  return text.length;
}

// A comment after the statement, alone on the rest of its line.
const TRAILING_COMMENT_RE =
  /^[ \t]*(?:\/\/[^\n]*|\/\*[^\n]*?\*\/[ \t]*)(?=\n|$)/;

/** Past a comment that ends the line: it was about the declaration. */
function withTrailingComment(text: string, end: number): number {
  const m = TRAILING_COMMENT_RE.exec(text.slice(end, end + 500));
  return m ? end + m[0].length : end;
}

// ---------------------------------------------------------------------------
// Plan

const SCSS_RE = /\.(scss|sass|less)$/;
const WS_RE = /\s/;
const PROPERTY_RE = /^\s*([-\w]+)\s*:/;

type Finding = DeadResult["dead"][number];

interface Edit {
  root: string;
  text: string;
  lines?: number[];
  ranges: Range[];
}

class Planner {
  fixed: Fixed[] = [];
  skipped: Skipped[] = [];
  removed = new Map<string, DeadDeclaration[]>();
  #edits = new Map<string, Edit>();

  skip(entry: string, d: Finding, reason: string) {
    this.skipped.push({
      entry,
      selector: d.selector,
      property: d.property,
      value: d.value,
      source: d.source,
      reason,
    });
  }

  fix(entry: string, d: Finding, at: { file: string; line: number }) {
    this.fixed.push({
      entry,
      ...at,
      selector: d.selector,
      property: d.property,
      value: d.value,
      by: { property: d.by.property, value: d.by.value },
    });
    pushTo(this.removed, entry, d);
  }

  /** The pending edit of a file, read once. */
  edit(path: string, root: string): Edit {
    let e = this.#edits.get(path);
    if (!e) {
      e = { root, text: readFileSync(path, "utf8"), ranges: [] };
      this.#edits.set(path, e);
    }
    return e;
  }

  plan(): FixPlan {
    const files: FixPlan["files"] = [];
    for (const [path, e] of this.#edits)
      if (e.ranges.length > 0)
        files.push({
          file: relative(e.root, path),
          before: e.text,
          after: apply(e.text, e.ranges),
        });
    return {
      fixed: this.fixed,
      skipped: this.skipped,
      files,
      removed: this.removed,
    };
  }
}

/** Deletes dead declarations from a CSS file, and rules left empty. */
function fixCss(p: Planner, sheet: Sheet, file: string, r: DeadResult) {
  const e = p.edit(resolve(sheet.root, file), sheet.root);
  for (const d of r.dead) {
    const range = cssRange(e.text, d.span);
    e.ranges.push({
      start: range.start,
      end: withTrailingComment(e.text, range.end),
    });
    p.fix(r.entry, d, { file, line: d.loc?.line ?? 0 });
  }
  const gone = new Set(r.dead.map((d) => d.span[0]));
  const visit = (nodes: Node[]) => {
    for (const n of nodes) {
      if (
        n.kind === "rule" &&
        n.rules.length === 0 &&
        n.decls.length > 0 &&
        n.decls.every((d) => gone.has(d.start))
      )
        e.ranges.push({ start: n.preludeStart, end: n.end });
      else if (n.rules) visit(n.rules);
    }
  };
  visit(parseStylesheet(e.text));
}

const posKey = (s: SourceLocation) => `${s.file}:${s.line}:${s.column}`;

type Productions = Map<string, { total: number; dead: number }>;

/**
 * Per source position: how many compiled declarations it produces across
 * the mapped stylesheets, and how many of those are dead.
 */
function productions(
  sheets: Sheet[],
  results: DeadResult[],
  locators: Map<Sheet, Locate>,
): Productions {
  const out: Productions = new Map();
  for (const [sheet, locate] of locators) {
    const at = lineIndex(sheet.css);
    const visit = (nodes: Node[]) => {
      for (const n of nodes) {
        for (const d of n.decls ?? []) {
          const s = locate(at(d.start));
          if (!s) continue;
          const c = out.get(posKey(s)) ?? { total: 0, dead: 0 };
          c.total++;
          out.set(posKey(s), c);
        }
        if (n.rules) visit(n.rules);
      }
    };
    visit(parseStylesheet(sheet.css));
  }
  for (const r of results) {
    const sheet = sheets.find((s) => s.name === r.entry);
    const locate = sheet && locators.get(sheet);
    if (!locate) continue;
    for (const d of r.dead) {
      const s = locate(d.loc);
      const c = s && out.get(posKey(s));
      if (c) c.dead++;
    }
  }
  return out;
}

/** Deletes dead declarations in the sources, where everything they produce is dead. */
function fixSources(
  p: Planner,
  sheet: Sheet,
  r: DeadResult,
  locate: Locate,
  produced: Productions,
) {
  const done = new Set<string>();
  for (const d of r.dead) {
    const s = locate(d.loc);
    if (!s) {
      p.skip(r.entry, d, "the source map has no position for it");
      continue;
    }
    const key = posKey(s);
    const c = produced.get(key);
    if (!c || c.dead < c.total) {
      p.skip(
        r.entry,
        d,
        "its source also produces declarations that aren't dead (a mixin, a loop, or another stylesheet)",
      );
      continue;
    }
    const path = resolve(sheet.root, s.file);
    const rel = relative(sheet.root, path);
    if (
      isAbsolute(rel) ||
      rel.startsWith("..") ||
      rel.split(sep).includes("node_modules")
    ) {
      p.skip(r.entry, d, `its source is outside the project: ${s.file}`);
      continue;
    }
    if (!existsSync(path)) {
      p.skip(r.entry, d, `its source doesn't exist: ${s.file}`);
      continue;
    }
    if (!done.has(key)) {
      const e = p.edit(path, sheet.root);
      e.lines ??= lineStarts(e.text);
      const start = (e.lines[s.line - 1] ?? e.text.length) + s.column;
      const name = PROPERTY_RE.exec(e.text.slice(start, start + 200))?.[1];
      if (name?.toLowerCase() !== d.property.toLowerCase()) {
        p.skip(
          r.entry,
          d,
          `${s.file}:${s.line} isn't a \`${d.property}\` declaration`,
        );
        continue;
      }
      e.ranges.push({
        start,
        end: withTrailingComment(
          e.text,
          statementEnd(e.text, start, SCSS_RE.test(path)),
        ),
      });
      done.add(key);
    }
    p.fix(r.entry, d, { file: s.file, line: s.line });
  }
}

/**
 * What `--fix` would change. `generated`: the config's `build` writes the
 * stylesheets, so only their sources may be edited.
 */
function planFix(
  sheets: Sheet[],
  results: DeadResult[],
  generated: boolean,
): FixPlan {
  const p = new Planner();
  const locators = new Map<Sheet, Locate>();
  for (const sheet of sheets)
    if (sheet.map) locators.set(sheet, mappedLocator(sheet));
  const produced = productions(sheets, results, locators);
  for (const r of results) {
    const sheet = sheets.find((s) => s.name === r.entry);
    if (!sheet) continue;
    const locate = locators.get(sheet);
    if (locate) fixSources(p, sheet, r, locate, produced);
    else if (sheet.file && !generated) fixCss(p, sheet, sheet.file, r);
    else
      for (const d of r.dead)
        p.skip(
          r.entry,
          d,
          sheet.file
            ? "the config's `build` writes this file; emit a source map to fix its sources"
            : "compiled in-process without a source map: nothing to edit",
        );
  }
  return p.plan();
}

// ---------------------------------------------------------------------------
// Apply

export interface FixReport {
  fixed: Fixed[];
  skipped: Skipped[];
  /** Files changed (or that would change, with `dryRun`). */
  files: string[];
  written: boolean;
  /**
   * `verified`: re-analyzed, the stylesheets lost exactly the fixed
   * declarations. `unverified`: sources were edited but can't be rebuilt
   * here (CSS files given on the command line); rebuild and run again.
   */
  check: "verified" | "unverified";
  /** With `dryRun`: the edits as a unified diff. */
  patch?: string;
}

/** Thrown, after restoring the files, when an edit changed more than it should. */
export class FixCheckError extends Error {}

/** Entries whose declarations aren't `before` minus `removed`. */
function mismatches(
  before: Sheet[],
  after: Sheet[],
  removed: Map<string, DeadDeclaration[]>,
): string[] {
  return before
    .filter((b) => {
      const a = after.find((s) => s.name === b.name);
      if (!a) return true;
      const expected = expectedAfter(
        declarationsOf(b.css),
        removed.get(b.name) ?? [],
      );
      return !sameCounts(expected, declarationsOf(a.css));
    })
    .map((s) => s.name);
}

export async function fix(opts: {
  sheets: Sheet[];
  results: DeadResult[];
  root: string;
  /** The config's `build` writes the stylesheets. */
  generated: boolean;
  dryRun: boolean;
  /** Reads the stylesheets again (rebuilding them); null when that's not possible. */
  reload: (() => Promise<Sheet[]>) | null;
}): Promise<FixReport> {
  const plan = planFix(opts.sheets, opts.results, opts.generated);
  const changed = new Map(plan.files.map((f) => [f.file, f.after]));
  // Stylesheets edited directly can be checked before anything is written.
  const direct = opts.sheets.filter(
    (s) => !s.map && s.file && changed.has(s.file),
  );
  const inMemory = direct.map((s) => ({
    ...s,
    css: changed.get(s.file as string) as string,
  }));
  const bad = mismatches(direct, inMemory, plan.removed);
  if (bad.length > 0)
    throw new FixCheckError(
      `the fix would change more than dead declarations in ${bad.join(", ")}; nothing written`,
    );
  const sourcesEdited = plan.files.some(
    (f) => !direct.some((s) => s.file === f.file),
  );

  const report: FixReport = {
    fixed: plan.fixed,
    skipped: plan.skipped,
    files: plan.files.map((f) => f.file),
    written: false,
    check: sourcesEdited ? "unverified" : "verified",
  };
  if (opts.dryRun) {
    report.patch = await unifiedDiff(plan.files);
    return report;
  }
  const write = (which: "before" | "after") =>
    Promise.all(
      plan.files.map((f) => Bun.write(resolve(opts.root, f.file), f[which])),
    );
  await write("after");
  report.written = true;
  if (sourcesEdited && opts.reload) {
    let after: Sheet[];
    try {
      after = await opts.reload();
    } catch (e) {
      await write("before");
      throw new FixCheckError(
        `rebuilding after the fix failed, so it was undone: ${(e as Error).message}`,
      );
    }
    const wrong = mismatches(opts.sheets, after, plan.removed);
    if (wrong.length > 0) {
      await write("before");
      throw new FixCheckError(
        `after the fix, ${wrong.join(", ")} changed more than its dead declarations, so the fix was undone`,
      );
    }
    report.check = "verified";
  }
  return report;
}

/** The edits as a unified diff, paths relative to the root. */
async function unifiedDiff(files: FixPlan["files"]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crassus-fix-"));
  try {
    await Promise.all(
      files.flatMap((f) => [
        Bun.write(join(dir, "a", f.file), f.before),
        Bun.write(join(dir, "b", f.file), f.after),
      ]),
    );
    // With --no-prefix, the `a` and `b` directories are the prefixes.
    const proc = Bun.spawn(
      ["git", "diff", "--no-index", "--no-color", "--no-prefix", "a", "b"],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
