// Small DOM trees on which one element matches several selectors: what
// confirming a static cascade flip in a real engine needs when no fixture
// renders the combination. Candidates only: the engine checks them.
import { attrConstraint, type Part, parseComplex } from "./selector";

/** `[localName, attributes, children, namespace?]`, as the page index records pages. */
export type Tree = [string, Record<string, string>, Tree[], string?];

interface El {
  tag: string | null;
  classes: Set<string>;
  attrs: Map<string, string>;
  children: El[];
  target?: boolean;
}

type Step = { comb: string; el: El };

const PARENT = new Set([" ", ">"]);
const OPERAND_RE = /[~|^$*]?=\s*"?([^"\]\s]*)/;

function elementOf(parts: Part[]): El {
  const el: El = {
    tag: null,
    classes: new Set(),
    attrs: new Map(),
    children: [],
  };
  for (const p of parts) {
    if (p.t === "type") el.tag = p.name;
    else if (p.t === "class") el.classes.add(p.name);
    else if (p.t === "id") el.attrs.set("id", p.name);
    else if (p.t === "attr") {
      const { name, value } = attrConstraint(p.raw);
      // An operator other than `=` only needs the attribute: its operand
      // satisfies `^=`, `$=`, `*=`, `~=` and `|=`.
      const operand = OPERAND_RE.exec(p.raw)?.[1] ?? "";
      el.attrs.set(name, value ?? operand);
    }
  }
  return el;
}

/** One element meeting both, or null when they can't: two tags, two ids. */
function merge(a: El, b: El): El | null {
  if (a.tag && b.tag && a.tag !== b.tag) return null;
  const attrs = new Map(a.attrs);
  for (const [k, v] of b.attrs) {
    const was = attrs.get(k);
    if (was !== undefined && was !== "" && v !== "" && was !== v) return null;
    attrs.set(k, was || v);
  }
  return {
    tag: a.tag ?? b.tag,
    classes: new Set([...a.classes, ...b.classes]),
    attrs,
    children: [],
  };
}

/** The selector from its subject outward: the subject, then each step with the combinator that joins it. */
function chainOf(selector: string): { subject: El; steps: Step[] } | null {
  const sel = parseComplex(selector);
  const els = sel.compounds.map((c) => elementOf(c.parts));
  if (els.length === 0) return null;
  const steps: Step[] = [];
  for (let i = els.length - 2; i >= 0; i--)
    steps.push({ comb: sel.combinators[i] ?? " ", el: els[i] });
  return { subject: els[els.length - 1], steps };
}

const copy = (e: El): El => ({
  ...e,
  classes: new Set(e.classes),
  attrs: new Map(e.attrs),
  children: [],
});

/** Builds around `subject`, from the inside out, applying `steps` in order. */
function wrap(group: El[], anchor: El, steps: Step[]): El[] {
  let out = group;
  let at = anchor;
  for (const { comb, el } of steps) {
    const e = copy(el);
    if (PARENT.has(comb)) {
      e.children = out;
      out = [e];
    } else {
      // A sibling before: right before for `+`, anywhere before for `~`.
      const i = out.indexOf(at);
      out = [...out.slice(0, i), e, ...out.slice(i)];
    }
    at = e;
  }
  return out;
}

/** Steps of two chains taken level by level, merged where both have one. */
function lockstep(a: Step[], b: Step[]): Step[] | null {
  const out: Step[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) {
      out.push((x ?? y) as Step);
      continue;
    }
    if (PARENT.has(x.comb) === PARENT.has(y.comb)) {
      const el = merge(x.el, y.el);
      if (!el) return null;
      out.push({ comb: x.comb === ">" || y.comb === ">" ? ">" : x.comb, el });
    } else if (PARENT.has(x.comb)) out.push(y, x);
    // Siblings stay at this level: before going up.
    else out.push(x, y);
  }
  return out;
}

function toTree(e: El): Tree {
  const attrs: Record<string, string> = Object.fromEntries(e.attrs);
  if (e.classes.size) attrs.class = [...e.classes].join(" ");
  if (e.target) attrs["data-cr-target"] = "";
  return [
    e.tag && e.tag !== "*" ? e.tag : "div",
    attrs,
    e.children.map(toTree),
  ];
}

const ROOTS = new Set(["html", "body"]);

/**
 * Candidate pages (`<html>` trees, empty `<head>`) on which the element
 * marked `data-cr-target` might match both selectors (relaxed: no states,
 * no pseudo-elements): merged level by level, or one chain nested in the
 * other. The engine has to check them.
 */
export function synthesize(a: string, b: string): Tree[] {
  const ca = chainOf(a);
  const cb = chainOf(b);
  if (!ca || !cb) return [];
  const subject = merge(ca.subject, cb.subject);
  if (!subject) return [];
  subject.target = true;
  const plans: Step[][] = [];
  const both = lockstep(ca.steps, cb.steps);
  if (both) plans.push(both);
  plans.push([...cb.steps, ...ca.steps], [...ca.steps, ...cb.steps]);
  return plans.map((steps) => {
    // A step on html or body is the page's own.
    const inner = steps.filter((s) => !ROOTS.has(s.el.tag ?? ""));
    const body = wrap([subject], subject, inner);
    const rootAttrs = (tag: string) => {
      const found = steps.find((s) => s.el.tag === tag);
      return found ? toTree(found.el)[1] : {};
    };
    return [
      "html",
      rootAttrs("html"),
      [
        ["head", {}, []],
        ["body", rootAttrs("body"), body.map(toTree)],
      ],
    ] as Tree;
  });
}

/** Classes and attribute names a selector requires (outside `:not()`). */
export function vocabularyOf(selector: string): string[] {
  const out = new Set<string>();
  for (const c of parseComplex(selector).compounds)
    for (const p of c.parts) {
      if (p.t === "class") out.add(`.${p.name}`);
      else if (p.t === "attr") out.add(`[${attrConstraint(p.raw).name}]`);
    }
  return [...out];
}
