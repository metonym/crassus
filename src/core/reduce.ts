// Delta debugging over a stylesheet change: the change as declaration-level
// edits (one unit per declaration, in source order), any subset of them
// applied to base as CSS, and ddmin (Zeller and Hildebrandt) to find a
// 1-minimal subset that still reproduces an effect.
import { parseRules, type Rule } from "./cascade";
import { type Node, parseStylesheet } from "./parse";

/** One declaration where it sits: what a stylesheet is, in order. */
export interface Unit {
  /** `@media …`, `@layer …`, `@scope …`, outermost first. */
  contexts: string[];
  selector: string;
  property: string;
  /** With ` !important` when it is. */
  value: string;
  /** 1-based line of the selector, with `positions`. */
  line?: number;
  /** A whole `@keyframes` block, kept as one unit. */
  block?: string;
}

const key = (u: Unit) =>
  u.block ??
  `${u.contexts.join(" / ")}\0${u.selector}\0${u.property}\0${u.value}`;

const KEYFRAMES_RE = /^@(?:-[a-z]+-)?keyframes /;

function contextsOf(r: Rule): string[] {
  const out = r.context ? r.context.split(" / ") : [];
  if (r.layer) out.push(`@layer ${r.layer}`);
  if (r.scope) out.push(...r.scope.split(" / "));
  return out;
}

/** The stylesheet as units, and the at-rules that hold no declarations of style rules. */
export function cssUnits(css: string): { prelude: string; units: Unit[] } {
  const units: Unit[] = [];
  const frames = new Map<string, Unit>();
  for (const r of parseRules(css, true)) {
    const contexts = contextsOf(r);
    const keyframes = contexts.find((c) => KEYFRAMES_RE.test(c));
    if (keyframes) {
      // A later @keyframes of the same name replaces the earlier one whole.
      let u = frames.get(keyframes);
      if (!u) {
        u = { contexts: [], selector: "", property: "", value: "", block: "" };
        frames.set(keyframes, u);
        units.push(u);
      }
      const decls = [...r.decls].map(([p, v]) => `${p}: ${v}`).join("; ");
      u.block = `${u.block}${r.selector} { ${decls} }`;
      continue;
    }
    for (const [property, value] of r.decls)
      units.push({
        contexts,
        selector: r.selector,
        property,
        value,
        ...(r.loc && { line: r.loc.line }),
      });
  }
  for (const [name, u] of frames) u.block = `${name} { ${u.block} }`;
  return { prelude: prelude(parseStylesheet(css)), units };
}

// At-rules other than group rules: `@import`, `@font-face`, `@property`,
// `@layer` statements, …; first, as they come.
function prelude(nodes: Node[]): string {
  const out: string[] = [];
  const walk = (list: Node[]) => {
    for (const n of list) {
      if (n.kind === "rule" || n.rules) {
        if (n.kind === "at" && n.rules) walk(n.rules);
        continue;
      }
      if (n.name === "charset") continue;
      const decls = (n.decls ?? []).map(
        (d) => `${d.property}: ${d.raw}${d.important ? " !important" : ""}`,
      );
      const head = [`@${n.name}`, n.prelude.trim()].filter(Boolean).join(" ");
      out.push(n.decls ? `${head} { ${decls.join("; ")} }` : `${head};`);
    }
  };
  walk(nodes);
  return out.join("\n");
}

export type Step = { op: "=" | "-" | "+"; unit: Unit };

/** The shortest edit script from `a` to `b` (Myers), as kept, removed and added units. */
export function diffUnits(a: Unit[], b: Unit[]): Step[] {
  const ka = a.map(key);
  const kb = b.map(key);
  const n = ka.length;
  const m = kb.length;
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[max + k - 1] < v[max + k + 1])
          ? v[max + k + 1]
          : v[max + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && ka[x] === kb[y]) {
        x++;
        y++;
      }
      v[max + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  // Walk back through the saved frontiers.
  const steps: Step[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const t = trace[d];
    const k = x - y;
    const prev =
      k === -d || (k !== d && t[max + k - 1] < t[max + k + 1]) ? k + 1 : k - 1;
    const px = t[max + prev];
    const py = px - prev;
    while (x > px && y > py) {
      steps.push({ op: "=", unit: a[--x] });
      y--;
    }
    if (d > 0) {
      if (x === px) steps.push({ op: "+", unit: b[--y] });
      else steps.push({ op: "-", unit: a[--x] });
    }
  }
  return steps.reverse();
}

/** One unit as CSS: its declaration in its own rule, in its contexts. */
export function serializeUnit(u: Unit): string {
  if (u.block) return u.block;
  let out = `${u.selector} { ${u.property}: ${u.value} }`;
  for (const c of [...u.contexts].reverse()) out = `${c} { ${out} }`;
  return out;
}

/**
 * Base with the edits whose indexes (into `script`'s `-` and `+` steps, in
 * order) are in `chosen` applied: removed units dropped, added ones put
 * where head has them.
 */
export function applyEdits(
  prelude: string,
  script: Step[],
  chosen: ReadonlySet<number>,
): string {
  const out = [prelude];
  let i = 0;
  for (const s of script) {
    if (s.op === "=") out.push(serializeUnit(s.unit));
    else {
      const on = chosen.has(i++);
      if ((s.op === "-") !== on) out.push(serializeUnit(s.unit));
    }
  }
  return out.join("\n");
}

/**
 * A 1-minimal subset of `items` that `fails` (reproduces the effect),
 * given that all of them do: removing any one item of the result stops
 * it. Tests run one at a time.
 */
export async function ddmin<T>(
  items: T[],
  fails: (subset: T[]) => Promise<boolean>,
): Promise<T[]> {
  let c = items;
  let n = 2;
  while (c.length >= 2) {
    const size = Math.ceil(c.length / n);
    const parts: T[][] = [];
    for (let i = 0; i < c.length; i += size) parts.push(c.slice(i, i + size));
    let reduced = false;
    for (const part of parts) {
      // biome-ignore lint/performance/noAwaitInLoops: one test at a time
      if (await fails(part)) {
        c = part;
        n = 2;
        reduced = true;
        break;
      }
    }
    if (!reduced && parts.length > 2)
      for (const part of parts) {
        const rest = c.filter((x) => !part.includes(x));
        // biome-ignore lint/performance/noAwaitInLoops: one test at a time
        if (await fails(rest)) {
          c = rest;
          n = Math.max(n - 1, 2);
          reduced = true;
          break;
        }
      }
    if (reduced) continue;
    if (n >= c.length) break;
    n = Math.min(c.length, 2 * n);
  }
  return c;
}
