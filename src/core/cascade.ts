/** The rule model (`parseRules`) and the cascade relations `cascadeDiff` uses. */

import { canonicalText, locator, parseStylesheet } from "./parse";
import { placeRules } from "./placement";
import {
  argList,
  attrConstraint,
  type Complex,
  compareSpecificity,
  type Part,
  type Specificity,
  serialize,
  specificity,
} from "./selector";
import { pushTo } from "./util";

/** One selector of a style rule. */
export interface Rule {
  /** `@media`, `@supports`, `@container`, …, outermost first, joined with " / ". See `canonicalContext`. */
  context: string;
  /** Dotted layer name, `""` when unlayered. */
  layer: string;
  /** Higher wins for normal declarations; unlayered is highest. `!important` reverses it. */
  layerRank: number;
  /** `@scope` chain. */
  scope: string;
  /** See `canonicalSelector`. */
  selector: string;
  specificity: Specificity;
  order: number;
  /** Property -> value, `!important` kept as a suffix. */
  decls: Map<string, string>;
  declBlock: string;
  subject: Subject;
  /** Placement, selector and declarations: the identity `cascadeDiff` counts. */
  key: string;
  /** Where the selector starts (1-based line, 0-based column), with `positions`. */
  loc?: { line: number; column: number };
}

interface Subject {
  classes: ReadonlySet<string>;
  negated: ReadonlySet<string>;
  /** Name -> exact value (`[data-state=open]`), or null if it only has to be there (`[hidden]`). */
  attrs: ReadonlyMap<string, string | null>;
  /** `name` or `name=value`, from `:not([…])`. */
  negatedAttrs: ReadonlySet<string>;
  pseudoElement: string | null;
  type: string | null;
  allClasses: ReadonlySet<string>;
  allNegated: ReadonlySet<string>;
  qualified: boolean;
}

// Most selectors negate nothing and have no attributes: they share these.
const NONE: ReadonlySet<string> = new Set();
const NO_ATTRS: ReadonlyMap<string, string | null> = new Map();

interface Classes {
  found: Set<string>;
  negated: Set<string> | undefined;
}

function collectClasses(sel: Complex, into: Classes, negated: boolean): void {
  const { compounds } = sel;
  for (let i = 0; i < compounds.length; i++) {
    const { parts } = compounds[i];
    for (let j = 0; j < parts.length; j++) {
      const p = parts[j];
      if (p.t === "class") {
        if (!negated) into.found.add(p.name);
        else {
          into.negated ??= new Set();
          into.negated.add(p.name);
        }
      } else {
        const list = argList(p);
        if (!list) continue;
        const neg = negated || (p.t === "pseudo-class" && p.name === "not");
        for (let k = 0; k < list.length; k++)
          collectClasses(list[k], into, neg);
      }
    }
  }
}

// Pseudo-classes whose argument applies to the element itself.
const SAME_ELEMENT = new Set([
  "is",
  "where",
  "matches",
  "-webkit-any",
  "-moz-any",
]);

/** One compound's attribute constraints, including `:is()`/`:where()` of a single compound. */
function addAttrs(
  parts: Part[],
  attrs: Map<string, string | null> | undefined,
): Map<string, string | null> | undefined {
  let out = attrs;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.t === "attr") {
      const { name, value } = attrConstraint(p.raw);
      out ??= new Map();
      if (value !== null || !out.has(name)) out.set(name, value);
    } else if (
      p.t === "pseudo-class" &&
      p.list?.length === 1 &&
      p.list[0].compounds.length === 1 &&
      SAME_ELEMENT.has(p.name)
    ) {
      out = addAttrs(p.list[0].compounds[0].parts, out);
    }
  }
  return out;
}

function subjectOf(sel: Complex): Subject {
  const all: Classes = { found: new Set(), negated: undefined };
  collectClasses(sel, all, false);
  if (all.negated) for (const c of all.negated) all.found.delete(c);

  const { compounds } = sel;
  let qualified = false;
  for (let i = 0; i < compounds.length && !qualified; i++) {
    let hasType = false;
    let hasClass = false;
    const { parts } = compounds[i];
    for (let j = 0; j < parts.length; j++) {
      if (parts[j].t === "type") hasType = true;
      else if (parts[j].t === "class") hasClass = true;
    }
    qualified = hasType && hasClass;
  }

  const classes = new Set<string>();
  const negated: Classes = { found: new Set(), negated: undefined };
  let negatedAttrs: Set<string> | undefined;
  let pseudoElement: string | null = null;
  let type: string | null = null;
  const parts =
    compounds.length > 0 ? compounds[compounds.length - 1].parts : [];
  const attrs = addAttrs(parts, undefined);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.t === "class") classes.add(p.name);
    else if (p.t === "type") type = p.name;
    else if (p.t === "pseudo-element") pseudoElement = p.name;
    else if (p.t === "pseudo-class" && p.name === "not" && p.list) {
      for (const inner of p.list) {
        collectClasses(inner, negated, false);
        // `:not([a][b])` doesn't exclude `[a]`: only a lone attribute counts.
        const only = inner.compounds.length === 1 && inner.compounds[0].parts;
        if (only && only.length === 1 && only[0].t === "attr") {
          const { name, value } = attrConstraint(only[0].raw);
          negatedAttrs ??= new Set();
          negatedAttrs.add(value === null ? name : `${name}=${value}`);
        }
      }
    }
  }
  return {
    classes,
    negated: negated.found.size > 0 ? negated.found : NONE,
    attrs: attrs ?? NO_ATTRS,
    negatedAttrs: negatedAttrs ?? NONE,
    pseudoElement,
    type,
    allClasses: all.found,
    allNegated: all.negated ?? NONE,
    qualified,
  };
}

const WS_RUN_RE = /\s+/g;
const UNUSUAL_WS_RE = /\s\s|[\t\n\r\f]/;
const collapseWs = (s: string) =>
  UNUSUAL_WS_RE.test(s) ? s.replace(WS_RUN_RE, " ") : s;

export function canonicalValue(
  raw: string,
  important: boolean,
  property = "",
): string {
  // Custom property values keep their comments: `--x: /*!*/ /*!*/` is a space.
  const value = property.startsWith("--")
    ? collapseWs(raw.trim())
    : canonicalText(raw);
  return value + (important ? " !important" : "");
}

export function parseRules(css: string, positions = false): Rule[] {
  const placed = placeRules(parseStylesheet(css));
  const loc = positions ? locator(css) : null;
  const rules: Rule[] = [];
  for (let order = 0; order < placed.length; order++) {
    const { selectors, decls: list, context, layer, scope } = placed[order];
    const decls = new Map<string, string>();
    // A repeated property keeps its first position and its last value.
    const pairs: string[] = [];
    let repeated = false;
    for (let k = 0; k < list.length; k++) {
      const d = list[k];
      const prop = d.property.toLowerCase();
      const value = canonicalValue(d.raw, d.important, d.property);
      if (decls.has(prop)) repeated = true;
      decls.set(prop, value);
      pairs.push(`${prop}:${value}`);
    }
    if (repeated) {
      pairs.length = 0;
      for (const [p, v] of decls) pairs.push(`${p}:${v}`);
    }
    const declBlock = pairs.join(";");
    const where = placementKey(context, layer.name, scope);
    for (const { complex, offset } of selectors) {
      const selector = serialize(complex);
      const rule: Rule = {
        context,
        layer: layer.name,
        layerRank: layer.rank,
        scope,
        selector,
        specificity: specificity(complex),
        order,
        decls,
        declBlock,
        subject: subjectOf(complex),
        key: `${where} ${selector} ${declBlock}`,
      };
      if (loc) rule.loc = loc(offset);
      rules.push(rule);
    }
  }
  return rules;
}

/** Context, layer and scope as one string. */
function placementKey(context: string, layer: string, scope: string): string {
  let key = context;
  if (layer) key = key ? `${key} / @layer ${layer}` : `@layer ${layer}`;
  if (scope) key = key ? `${key} / ${scope}` : scope;
  return key;
}

export const samePlacement = (a: Rule, b: Rule): boolean =>
  a.context === b.context && a.layer === b.layer && a.scope === b.scope;

// ---------------------------------------------------------------------------
// Cascade relations

/** No element can meet both subjects' attribute constraints. */
function attrsExclude(x: Subject, y: Subject): boolean {
  for (const [name, value] of x.attrs) {
    if (y.negatedAttrs.has(name)) return true;
    if (value === null) continue;
    if (y.negatedAttrs.has(`${name}=${value}`)) return true;
    const other = y.attrs.get(name);
    // Some HTML attribute values (`type`) are case-insensitive.
    if (other != null && other.toLowerCase() !== value.toLowerCase())
      return true;
  }
  return false;
}

function shareAttr(x: Subject, y: Subject): boolean {
  for (const name of x.attrs.keys()) if (y.attrs.has(name)) return true;
  return false;
}

export function coMatchable(a: Rule, b: Rule): boolean {
  if (a.context !== b.context) return false;
  if (a.subject.pseudoElement !== b.subject.pseudoElement) return false;
  for (const c of a.subject.classes) if (b.subject.negated.has(c)) return false;
  for (const c of b.subject.classes) if (a.subject.negated.has(c)) return false;
  if (attrsExclude(a.subject, b.subject) || attrsExclude(b.subject, a.subject))
    return false;
  // `.x:not(.d) ~ .y` and `.x.d ~ .y` can't both match. Coarse: it ignores
  // which compound the class is in.
  for (const c of a.subject.allClasses) {
    if (b.subject.allNegated.has(c)) return false;
  }
  for (const c of b.subject.allClasses) {
    if (a.subject.allNegated.has(c)) return false;
  }
  // Without classes, a subject pairs through a shared attribute (headless
  // libraries style `[data-state=open]`), or as a type-only subject.
  if (a.subject.classes.size === 0 || b.subject.classes.size === 0) {
    const attrs = a.subject.attrs.size > 0 || b.subject.attrs.size > 0;
    if (a.subject.classes.size !== 0 || b.subject.classes.size !== 0) {
      return attrs && shareAttr(a.subject, b.subject);
    }
    if (a.subject.type && b.subject.type && a.subject.type !== b.subject.type) {
      return false;
    }
    if (attrs) return shareAttr(a.subject, b.subject);
    // Type-only subjects (`svg`, `tbody`) pair with each other: same type,
    // and a class shared somewhere, so `.x svg` and `.y > svg` don't.
    if (a.subject.allClasses.size === 0 || b.subject.allClasses.size === 0) {
      return true;
    }
    for (const c of a.subject.allClasses) {
      if (b.subject.allClasses.has(c)) return true;
    }
    return false;
  }
  for (const c of a.subject.classes) if (b.subject.classes.has(c)) return true;
  return false;
}

function propertiesConflict(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(`${b}-`) || b.startsWith(`${a}-`);
}

export function conflictingProps(a: Rule, b: Rule): string[] {
  const out: string[] = [];
  for (const pa of a.decls.keys()) {
    for (const pb of b.decls.keys()) {
      if (propertiesConflict(pa, pb)) out.push(pa === pb ? pa : `${pa}~${pb}`);
    }
  }
  return out;
}

function important(rule: Rule, prop: string): boolean {
  const v = rule.decls.get(prop);
  return v ? v.endsWith("!important") : false;
}

/**
 * Whether `a` beats `b` for a shared property on an element both match:
 * importance, layer (reversed for `!important`), specificity, scope
 * proximity, order. Scoped beats unscoped at equal specificity; between two
 * scopes proximity depends on the DOM, so order decides.
 */
export function wins(a: Rule, b: Rule, prop: string): boolean {
  const base = prop.split("~")[0];
  const ia = important(a, base);
  const ib = important(b, base);
  if (ia !== ib) return ia;
  if (a.layerRank !== b.layerRank)
    return ia ? a.layerRank < b.layerRank : a.layerRank > b.layerRank;
  const sp = compareSpecificity(a.specificity, b.specificity);
  if (sp !== 0) return sp > 0;
  if (a.scope !== b.scope && !(a.scope && b.scope)) return Boolean(a.scope);
  return a.order > b.order;
}

/**
 * Head rule -> base rule, for a dropped and a new rule with the same selector
 * and declarations in another context, layer or scope: a rule that moved
 * and gained or lost an `@media` (or layer) around it. The key differs, so
 * without this the pair reads as unrelated. Pairs are spliced out of
 * `removed` and `added`.
 */
export function matchContextMoves(
  removed: Rule[],
  added: Rule[],
): Map<Rule, Rule> {
  const moves = new Map<Rule, Rule>();
  const stillAdded: Rule[] = [];
  for (const a of added) {
    const i = removed.findIndex(
      (r) =>
        r.selector === a.selector &&
        r.declBlock === a.declBlock &&
        !samePlacement(r, a),
    );
    if (i >= 0) {
      moves.set(a, removed[i]);
      removed.splice(i, 1);
    } else {
      stillAdded.push(a);
    }
  }
  added.length = 0;
  added.push(...stillAdded);
  return moves;
}

export function indexBySubject(rules: Rule[]): {
  byClass: Map<string, Rule[]>;
  byAttr: Map<string, Rule[]>;
  noClass: Rule[];
} {
  const byClass = new Map<string, Rule[]>();
  const byAttr = new Map<string, Rule[]>();
  const noClass: Rule[] = [];
  for (const r of rules) {
    if (r.subject.classes.size === 0) noClass.push(r);
    for (const c of r.subject.classes) pushTo(byClass, c, r);
    for (const a of r.subject.attrs.keys()) pushTo(byAttr, a, r);
  }
  return { byClass, byAttr, noClass };
}

/** Rules that may be coMatchable with `rule`: a subject class or attribute in common. */
export function candidates(
  rule: Rule,
  index: ReturnType<typeof indexBySubject>,
): Rule[] {
  const { classes, attrs } = rule.subject;
  if (classes.size === 0 && attrs.size === 0)
    return index.noClass.filter((r) => r !== rule);
  const seen = new Set<Rule>();
  for (const c of classes) {
    for (const r of index.byClass.get(c) ?? []) seen.add(r);
  }
  for (const a of attrs.keys()) {
    for (const r of index.byAttr.get(a) ?? []) seen.add(r);
  }
  seen.delete(rule);
  return [...seen];
}

// ---------------------------------------------------------------------------
// Specificity profile

export interface Histogram {
  selectors: number;
  /** Selectors by class-tier specificity: 0..3, and 4 for four or more. */
  classes: [number, number, number, number, number];
  /** Selectors with a type-qualified class compound (`a.bx--link`). */
  qualified: number;
  max: Specificity;
}

export function histogram(rules: Iterable<Rule>): Histogram {
  const h: Histogram = {
    selectors: 0,
    classes: [0, 0, 0, 0, 0],
    qualified: 0,
    max: [0, 0, 0],
  };
  for (const r of rules) {
    h.selectors++;
    h.classes[Math.min(r.specificity[1], 4)]++;
    if (r.subject.qualified) h.qualified++;
    if (compareSpecificity(r.specificity, h.max) > 0) h.max = r.specificity;
  }
  return h;
}

/** Histograms by source file; rules `fileOf` can't place are under "?". */
export function histogramByFile(
  rules: Rule[],
  fileOf: (rule: Rule) => string | undefined,
): Map<string, Histogram> {
  const groups = new Map<string, Rule[]>();
  for (const r of rules) pushTo(groups, fileOf(r) ?? "?", r);
  const out = new Map<string, Histogram>();
  for (const [file, list] of groups) out.set(file, histogram(list));
  return out;
}
