import {
  AMP,
  BACKSLASH,
  COLON,
  COMMA,
  commentEnd,
  DASH,
  DOT,
  GT,
  HASH,
  isQuote,
  isWs,
  LBRACKET,
  LPAREN,
  PIPE,
  PLUS,
  RBRACKET,
  RPAREN,
  SLASH,
  STAR,
  stringEnd,
  TILDE,
  UNDERSCORE,
} from "./chars";

export type Specificity = [number, number, number];

export type Part =
  | { t: "type"; name: string }
  | { t: "universal" }
  | { t: "nesting" }
  | { t: "id"; name: string }
  | { t: "class"; name: string }
  | { t: "attr"; raw: string }
  | {
      t: "pseudo-class";
      name: string;
      /** Selector-list argument (`:is`, `:not`, `:where`, `:has`, `of S`). */
      list: Complex[] | null;
      /** Other argument text (`2n+1`, `ltr`). */
      arg: string | null;
    }
  | {
      t: "pseudo-element";
      name: string;
      /** Written with one colon (`:before`). */
      legacy: boolean;
      list: Complex[] | null;
      arg: string | null;
    }
  | { t: "raw"; text: string };

interface Compound {
  parts: Part[];
}

export interface Complex {
  compounds: Compound[];
  /** `combinators[i]` joins compounds[i] and compounds[i + 1]. */
  combinators: string[];
}

export const argList = (p: Part): Complex[] | null =>
  p.t === "pseudo-class" || p.t === "pseudo-element" ? p.list : null;

const SELECTOR_ARG = new Set([
  "is",
  "not",
  "where",
  "has",
  "matches",
  "-webkit-any",
  "-moz-any",
  "host",
  "host-context",
  "current",
  "past",
  "future",
]);
// Pseudo-classes that take their heaviest argument's specificity and none of their own.
const TAKES_ARG_SPECIFICITY = new Set([
  "is",
  "not",
  "has",
  "matches",
  "-webkit-any",
  "-moz-any",
]);
const NTH_OF = new Set(["nth-child", "nth-last-child"]);
const LEGACY_PSEUDO_ELEMENTS = new Set([
  "before",
  "after",
  "first-line",
  "first-letter",
]);
const NTH_OF_SPLIT_RE = /\s+of\s+/i;
const WS_RE = /\s/;
const WS_RUN_RE = /\s+/g;
const ASCII_START_RE = /^[a-z]/i;

const isLetter = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
const isIdentChar = (c: number) =>
  isLetter(c) ||
  (c >= 48 && c <= 57) ||
  c === DASH ||
  c === UNDERSCORE ||
  c >= 0x80;
const isIdentStart = (c: number) =>
  isLetter(c) || c === DASH || c === UNDERSCORE || c === BACKSLASH || c >= 0x80;
const isCombinator = (c: number) => c === GT || c === PLUS || c === TILDE;
const isComment = (text: string, i: number) =>
  text.charCodeAt(i) === SLASH && text.charCodeAt(i + 1) === STAR;

export function splitList(text: string): { text: string; offset: number }[] {
  // Most lists are one selector with nothing to trim.
  if (
    text.length > 0 &&
    !text.includes(",") &&
    !text.includes("/*") &&
    !isWs(text.charCodeAt(0)) &&
    !isWs(text.charCodeAt(text.length - 1))
  )
    return [{ text, offset: 0 }];
  const out: { text: string; offset: number }[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === BACKSLASH) i++;
    else if (isQuote(c)) i = stringEnd(text, i);
    else if (isComment(text, i)) i = commentEnd(text, i) - 1;
    else if (c === LPAREN || c === LBRACKET) depth++;
    else if (c === RPAREN || c === RBRACKET) depth--;
    else if (c === COMMA && depth === 0) {
      out.push(trimmed(text, start, i));
      start = i + 1;
    }
  }
  out.push(trimmed(text, start, text.length));
  return out.filter((s) => s.text.length > 0);
}

/** `text[start, end)` without surrounding whitespace and leading comments. */
function trimmed(text: string, start: number, end: number) {
  let a = start;
  let b = end;
  while (a < b && isWs(text.charCodeAt(a))) a++;
  while (text.startsWith("/*", a)) {
    a = Math.min(commentEnd(text, a), b);
    while (a < b && isWs(text.charCodeAt(a))) a++;
  }
  while (b > a && isWs(text.charCodeAt(b - 1))) b--;
  return { text: text.slice(a, b), offset: a };
}

// Selector-list arguments nested deeper than this (`:is(:is(…))`) are kept
// as text: recursing that deep would overflow.
const MAX_ARG_DEPTH = 256;
let argDepth = 0;

export function parseSelectorList(text: string): Complex[] {
  argDepth++;
  try {
    return splitList(text).map((s) => parseComplex(s.text));
  } finally {
    argDepth--;
  }
}

export function parseComplex(text: string): Complex {
  const n = text.length;
  let i = 0;
  const compounds: Compound[] = [];
  const combinators: string[] = [];
  let pendingCombinator: string | null = null;

  const readIdent = (): string => {
    const start = i;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === BACKSLASH) i += 2;
      else if (isIdentChar(c)) i++;
      else break;
    }
    return text.slice(start, i);
  };

  /** From an opening `(` or `[` to just past its match; returns what's inside. */
  const readGroup = (open: number, close: number): string => {
    let depth = 0;
    const start = i + 1;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === BACKSLASH) i += 2;
      else if (isQuote(c)) i = stringEnd(text, i) + 1;
      else {
        if (c === open) depth++;
        else if (c === close && --depth === 0) return text.slice(start, i++);
        i++;
      }
    }
    return text.slice(start);
  };

  const parseCompound = (): Compound => {
    const parts: Part[] = [];
    while (i < n) {
      const c = text.charCodeAt(i);
      if (isWs(c) || isCombinator(c) || isComment(text, i)) break;
      if (c === DOT) {
        i++;
        parts.push({ t: "class", name: readIdent() });
      } else if (c === HASH) {
        i++;
        parts.push({ t: "id", name: readIdent() });
      } else if (c === LBRACKET) {
        const start = i;
        readGroup(LBRACKET, RBRACKET);
        parts.push({ t: "attr", raw: canonicalAttr(text.slice(start, i)) });
      } else if (c === COLON) {
        const element = text.charCodeAt(i + 1) === COLON;
        i += element ? 2 : 1;
        const name = readIdent().toLowerCase();
        let list: Complex[] | null = null;
        let arg: string | null = null;
        if (text.charCodeAt(i) === LPAREN) {
          const inner = readGroup(LPAREN, RPAREN);
          if (argDepth >= MAX_ARG_DEPTH) arg = inner;
          else if (element ? name === "slotted" : SELECTOR_ARG.has(name))
            list = parseSelectorList(inner);
          else if (!element && NTH_OF.has(name)) {
            const m = NTH_OF_SPLIT_RE.exec(inner);
            arg = (m ? inner.slice(0, m.index) : inner)
              .replace(WS_RUN_RE, "")
              .toLowerCase();
            if (m) list = parseSelectorList(inner.slice(m.index + m[0].length));
          } else arg = inner.trim().replace(WS_RUN_RE, " ");
        }
        if (element || (LEGACY_PSEUDO_ELEMENTS.has(name) && arg === null))
          parts.push({
            t: "pseudo-element",
            name,
            legacy: !element,
            list,
            arg,
          });
        else parts.push({ t: "pseudo-class", name, list, arg });
      } else if (c === STAR) {
        i++;
        if (text.charCodeAt(i) === PIPE && text.charCodeAt(i + 1) !== PIPE) {
          i++; // `*|` namespace
          continue;
        }
        parts.push({ t: "universal" });
      } else if (c === AMP) {
        i++;
        parts.push({ t: "nesting" });
      } else if (isIdentStart(c)) {
        const name = readIdent();
        if (text.charCodeAt(i) === PIPE && text.charCodeAt(i + 1) !== PIPE) {
          i++; // `ns|` namespace
          continue;
        }
        parts.push({
          t: "type",
          name: ASCII_START_RE.test(name) ? name.toLowerCase() : name,
        });
      } else {
        // Keyframe selectors (`50%`) and anything unexpected.
        const start = i++;
        while (i < n && !isWs(text.charCodeAt(i))) i++;
        parts.push({ t: "raw", text: text.slice(start, i) });
      }
    }
    return { parts };
  };

  while (i < n) {
    while (i < n) {
      if (isWs(text.charCodeAt(i))) i++;
      else if (isComment(text, i)) i = commentEnd(text, i);
      else break;
    }
    if (i >= n) break;
    const c = text.charCodeAt(i);
    if (isCombinator(c)) {
      pendingCombinator = text[i++];
      continue;
    }
    if (c === PIPE && text.charCodeAt(i + 1) === PIPE) {
      pendingCombinator = "||";
      i += 2;
      continue;
    }
    if (compounds.length > 0) combinators.push(pendingCombinator ?? " ");
    else if (pendingCombinator) {
      // A relative selector (`> .a` in `:has()`) keeps its leading combinator.
      compounds.push({ parts: [] });
      combinators.push(pendingCombinator);
    }
    pendingCombinator = null;
    compounds.push(parseCompound());
  }
  return { compounds, combinators };
}

/** Whitespace dropped outside strings, except before a flag after an unquoted value (`[a=x i]`). */
function canonicalAttr(raw: string): string {
  if (!WS_RE.test(raw)) return raw;
  let out = "";
  let pendingWs = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (isQuote(c)) {
      const j = stringEnd(raw, i);
      out += raw.slice(i, j + 1);
      i = j;
      pendingWs = false;
      continue;
    }
    if (isWs(c)) {
      pendingWs = true;
      continue;
    }
    if (
      pendingWs &&
      isIdentChar(c) &&
      isIdentChar(out.charCodeAt(out.length - 1))
    )
      out += " ";
    pendingWs = false;
    out += raw[i];
    if (c === BACKSLASH && i + 1 < raw.length) out += raw[++i];
  }
  return out;
}

// `[ns|name op value flag]`, canonical.
const ATTR_RE =
  /^\[(?:(?:[^|\]=~^$*]*|\*)\|(?!=))?([^|\]=~^$*\s]+)(?:([~|^$*]?=)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s\]]+))?/;

// Name lowercased, without namespace; a value only for `=`, as other
// operators only require the attribute.
export function attrConstraint(raw: string): {
  name: string;
  value: string | null;
} {
  const m = ATTR_RE.exec(raw);
  if (!m) return { name: raw, value: null };
  const name = m[1].toLowerCase();
  if (m[2] !== "=") return { name, value: null };
  const v = m[3] ?? "";
  return { name, value: isQuote(v.charCodeAt(0)) ? v.slice(1, -1) : v };
}

const NESTING: Part = { t: "nesting" };

function nestingCount(sel: Complex): number {
  let n = 0;
  for (const c of sel.compounds) {
    for (const p of c.parts) {
      if (p.t === "nesting") n++;
      for (const inner of argList(p) ?? []) n += nestingCount(inner);
    }
  }
  return n;
}

function replaceNesting(sel: Complex, by: Part): Complex {
  return {
    compounds: sel.compounds.map((c) => ({
      parts: c.parts.map((p) => {
        if (p.t === "nesting") return by;
        const list = argList(p);
        return list
          ? { ...p, list: list.map((inner) => replaceNesting(inner, by)) }
          : p;
      }),
    })),
    combinators: sel.combinators,
  };
}

const weights = new WeakMap<Complex[], number>();
function weightOf(list: Complex[]): number {
  let w = weights.get(list);
  if (w !== undefined) return w;
  w = 0;
  for (const c of list) {
    for (const { parts } of c.compounds) {
      w += parts.length;
      for (const p of parts) {
        const inner = argList(p);
        if (inner) w += weightOf(inner);
      }
    }
  }
  weights.set(list, w);
  return w;
}

// Past this many parts, `&` is left unresolved: `.a, .b` nested dozens deep
// doubles at each level.
const MAX_RESOLVED_WEIGHT = 4096;

/**
 * As CSS Nesting reads it: `&` is `:is(<parent>)`, and a selector without `&`
 * is relative (`.b` is `& .b`, `> .b` is `& > .b`). A single parent selector
 * is spliced in when `&` only starts the selector: same elements, same
 * specificity, more readable.
 */
export function resolveNested(sel: Complex, parent: Complex[]): Complex {
  if (weightOf(parent) > MAX_RESOLVED_WEIGHT) return sel;
  let s = sel;
  let count = nestingCount(sel);
  if (count === 0) {
    count = 1;
    s =
      sel.compounds[0]?.parts.length === 0
        ? {
            compounds: [{ parts: [NESTING] }, ...sel.compounds.slice(1)],
            combinators: sel.combinators,
          }
        : {
            compounds: [{ parts: [NESTING] }, ...sel.compounds],
            combinators: [" ", ...sel.combinators],
          };
  }
  const p = parent.length === 1 ? parent[0] : undefined;
  const last = p?.compounds[p.compounds.length - 1];
  if (
    p &&
    last &&
    last.parts.length > 0 &&
    count === 1 &&
    s.compounds[0].parts[0]?.t === "nesting" &&
    !last.parts.some((part) => part.t === "pseudo-element")
  ) {
    return {
      compounds: [
        ...p.compounds.slice(0, -1),
        { parts: [...last.parts, ...s.compounds[0].parts.slice(1)] },
        ...s.compounds.slice(1),
      ],
      combinators: [...p.combinators, ...s.combinators],
    };
  }
  return replaceNesting(s, {
    t: "pseudo-class",
    name: "is",
    list: parent,
    arg: null,
  });
}

export function compareSpecificity(a: Specificity, b: Specificity): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function maxOf(list: Complex[] | null): Specificity {
  let best: Specificity = [0, 0, 0];
  for (const c of list ?? []) {
    const s = specificity(c);
    if (compareSpecificity(s, best) > 0) best = s;
  }
  return best;
}

export function specificity(sel: Complex): Specificity {
  const s: Specificity = [0, 0, 0];
  const add = (o: Specificity) => {
    s[0] += o[0];
    s[1] += o[1];
    s[2] += o[2];
  };
  for (const compound of sel.compounds) {
    for (const p of compound.parts) {
      if (p.t === "id") s[0]++;
      else if (p.t === "class" || p.t === "attr") s[1]++;
      else if (p.t === "type") s[2]++;
      else if (p.t === "pseudo-element") {
        s[2]++;
        add(maxOf(p.list));
      } else if (p.t === "pseudo-class" && p.name !== "where") {
        // `:nth-child(… of S)` and `:host(S)` count themselves and S.
        if (!TAKES_ARG_SPECIFICITY.has(p.name)) s[1]++;
        add(maxOf(p.list));
      }
    }
  }
  return s;
}

export function serialize(sel: Complex): string {
  let out = serializeCompound(sel.compounds[0] ?? { parts: [] });
  for (let i = 1; i < sel.compounds.length; i++)
    out += sel.combinators[i - 1] + serializeCompound(sel.compounds[i]);
  return out;
}

export function serializeList(list: Complex[]): string {
  return list.map(serialize).join(",");
}

function serializeCompound(c: Compound): string {
  let out = "";
  for (const p of c.parts) {
    switch (p.t) {
      case "type":
        out += p.name;
        break;
      case "universal":
        out += "*";
        break;
      case "nesting":
        out += "&";
        break;
      case "id":
        out += `#${p.name}`;
        break;
      case "class":
        out += `.${p.name}`;
        break;
      case "attr":
        out += p.raw;
        break;
      case "raw":
        out += p.text;
        break;
      default: {
        out +=
          p.t === "pseudo-element" && !p.legacy ? `::${p.name}` : `:${p.name}`;
        if (p.list || p.arg !== null) {
          const args: string[] = [];
          if (p.arg !== null) args.push(p.arg);
          if (p.list) args.push(serializeList(p.list));
          out += `(${args.join(" of ")})`;
        }
      }
    }
  }
  return out;
}

/**
 * A selector or list as `Rule.selector` spells it, to key a browser's selector
 * text (CDP's `selectorList.selectors[i].text`) to `parseRules`. Quotes stay
 * as written, as CDP reports them. Nested selectors only match once resolved
 * against their parents, as `Rule.selector` is.
 */
export function canonicalSelector(text: string): string {
  return serializeList(parseSelectorList(text));
}
