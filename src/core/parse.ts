// Not a full CSS Syntax parser: values stay raw text. Error recovery follows
// browsers (fuzz-tested against Chrome).

import {
  AT,
  BACKSLASH,
  COLON,
  COMMA,
  commentEnd,
  DASH,
  DQUOTE,
  EQ,
  GT,
  isQuote,
  isWs,
  LBRACE,
  LBRACKET,
  LF,
  LPAREN,
  LT,
  RBRACE,
  RBRACKET,
  RPAREN,
  SEMI,
  SLASH,
  SPACE,
  SQUOTE,
  STAR,
  stringEnd,
} from "./chars";

export interface Decl {
  property: string;
  /** `!important` removed; trimmed unless a custom property. */
  raw: string;
  important: boolean;
  start: number;
  /** Just past the value, before any `;`. */
  end: number;
}

interface StyleRule {
  kind: "rule";
  prelude: string;
  preludeStart: number;
  end: number;
  decls: Decl[];
  rules: Node[];
}

interface AtRule {
  kind: "at";
  /** Lowercased name without `@`. */
  name: string;
  prelude: string;
  start: number;
  /** `@font-face { … }`, or a group rule nested in a style rule. */
  decls: Decl[] | null;
  rules: Node[] | null;
}

export type Node = StyleRule | AtRule;

interface Block {
  decls: Decl[];
  rules: Node[];
  end: number;
}

const VENDOR_PREFIX_RE = /^-[a-z]+-/;
// What `scan` can skip without looking.
const PLAIN_RE = /[^"'/\\()[\]{};]+/y;
const IMPORTANT_RE = /!\s*important\s*(?:\/\*[\s\S]*?\*\/\s*)*$/i;

// Deeper blocks are skipped: no real sheet comes close, and the recursion
// would overflow.
export const MAX_DEPTH = 256;

export const unprefixed = (name: string) => name.replace(VENDOR_PREFIX_RE, "");

const DECL_AT_RULES = new Set([
  "font-face",
  "page",
  "property",
  "counter-style",
  "font-palette-values",
  "viewport",
  "view-transition",
  "position-try",
]);

export function parseStylesheet(css: string): Node[] {
  const n = css.length;

  function skipString(from: number, quote: number): number {
    let i = from + 1;
    while (i < n) {
      const c = css.charCodeAt(i);
      if (c === BACKSLASH) i += 2;
      else if (c === quote) return i + 1;
      else if (c === LF)
        return i; // unterminated: bad-string
      else i++;
    }
    return n;
  }

  function skipWsComments(from: number): number {
    let i = from;
    while (i < n) {
      const c = css.charCodeAt(i);
      if (isWs(c)) i++;
      else if (c === SLASH && css.charCodeAt(i + 1) === STAR)
        i = commentEnd(css, i);
      else break;
    }
    return i;
  }

  // The first `{`, `;` or `}` outside strings, comments, parens and
  // brackets. With `braces`, `{}` pairs nest (custom property values).
  function scan(from: number, braces: boolean): number {
    let i = from;
    let depth = 0;
    let braceDepth = 0;
    while (i < n) {
      PLAIN_RE.lastIndex = i;
      if (PLAIN_RE.test(css)) {
        i = PLAIN_RE.lastIndex;
        if (i >= n) break;
      }
      const c = css.charCodeAt(i);
      if (c === DQUOTE || c === SQUOTE) {
        i = skipString(i, c);
        continue;
      }
      if (c === SLASH && css.charCodeAt(i + 1) === STAR) {
        i = commentEnd(css, i);
        continue;
      }
      if (c === BACKSLASH) {
        i += 2;
        continue;
      }
      if (c === LPAREN || c === LBRACKET) depth++;
      else if (c === RPAREN || c === RBRACKET) {
        if (depth > 0) depth--;
      } else if (depth === 0) {
        if (braces && c === LBRACE) braceDepth++;
        else if (braces && c === RBRACE && braceDepth > 0) braceDepth--;
        else if (
          braceDepth === 0 &&
          (c === LBRACE || c === SEMI || c === RBRACE)
        )
          return i;
      }
      i++;
    }
    return n;
  }

  // `inStyle`: in a style rule, a group rule's block holds declarations too.
  function parseAtRule(
    start: number,
    inStyle: boolean,
  ): { node: AtRule; end: number } {
    let j = start + 1;
    while (j < n) {
      const c = css.charCodeAt(j);
      if (
        isWs(c) ||
        c === LBRACE ||
        c === SEMI ||
        c === LPAREN ||
        c === RBRACE ||
        c === DQUOTE ||
        c === SQUOTE ||
        (c === SLASH && css.charCodeAt(j + 1) === STAR)
      )
        break;
      j++;
    }
    const name = css.slice(start + 1, j).toLowerCase();
    const stop = scan(j, false);
    const prelude = css.slice(j, stop).trim();
    const node: AtRule = {
      kind: "at",
      name,
      prelude,
      start,
      decls: null,
      rules: null,
    };
    if (stop >= n) return { node, end: n };
    const c = css.charCodeAt(stop);
    if (c !== LBRACE) return { node, end: c === SEMI ? stop + 1 : stop };
    const declsOnly = DECL_AT_RULES.has(unprefixed(name));
    if (declsOnly || inStyle) {
      const r = parseDeclList(stop + 1);
      node.decls = r.decls;
      if (!declsOnly) node.rules = r.rules;
      return { node, end: r.end };
    }
    const r = parseRuleList(stop + 1);
    node.rules = r.nodes;
    return { node, end: r.end };
  }

  let depth = 0;

  function skipBlock(from: number): number {
    let i = from;
    let open = 1;
    while (i < n) {
      i = scan(i, false);
      if (i >= n) break;
      const c = css.charCodeAt(i);
      if (c === LBRACE) open++;
      else if (c === RBRACE && --open === 0) return i + 1;
      i++;
    }
    return n;
  }

  function parseRuleList(from: number): { nodes: Node[]; end: number } {
    if (depth >= MAX_DEPTH) return { nodes: [], end: skipBlock(from) };
    depth++;
    const r = readRuleList(from, true);
    depth--;
    return r;
  }

  function readRuleList(
    from: number,
    nested: boolean,
  ): { nodes: Node[]; end: number } {
    let i = from;
    const nodes: Node[] = [];
    while (true) {
      i = skipWsComments(i);
      if (i >= n) return { nodes, end: n };
      const c = css.charCodeAt(i);
      if (c === RBRACE && nested) return { nodes, end: i + 1 };
      if (c === AT) {
        const r = parseAtRule(i, false);
        nodes.push(r.node);
        i = r.end;
        continue;
      }
      if (css.startsWith("<!--", i)) {
        i += 4;
        continue;
      }
      if (css.startsWith("-->", i)) {
        i += 3;
        continue;
      }
      // A `;` (or a top-level `}`) becomes part of the prelude, which then
      // isn't a selector: browsers drop the rule.
      let stop = scan(i, false);
      let invalid = false;
      while (stop < n && css.charCodeAt(stop) !== LBRACE) {
        if (nested && css.charCodeAt(stop) === RBRACE)
          return { nodes, end: stop + 1 };
        invalid = true;
        stop = scan(stop + 1, false);
      }
      if (stop >= n) return { nodes, end: n };
      const rule = parseStyleRule(i, stop);
      if (!invalid) nodes.push(rule);
      i = rule.end;
    }
  }

  function parseStyleRule(start: number, brace: number): StyleRule {
    const r = parseDeclList(brace + 1);
    return {
      kind: "rule",
      prelude: css.slice(start, brace).trim(),
      preludeStart: start,
      end: r.end,
      decls: r.decls,
      rules: r.rules,
    };
  }

  function parseDeclList(from: number): Block {
    if (depth >= MAX_DEPTH)
      return { decls: [], rules: [], end: skipBlock(from) };
    depth++;
    const r = readDeclList(from);
    depth--;
    return r;
  }

  function readDeclList(from: number): Block {
    let i = from;
    const decls: Decl[] = [];
    const rules: Node[] = [];
    while (true) {
      i = skipWsComments(i);
      if (i >= n) return { decls, rules, end: n };
      const c = css.charCodeAt(i);
      if (c === RBRACE) return { decls, rules, end: i + 1 };
      if (c === SEMI) {
        i++;
        continue;
      }
      if (c === AT) {
        const r = parseAtRule(i, true);
        rules.push(r.node);
        i = r.end;
        continue;
      }
      const custom = c === DASH && css.charCodeAt(i + 1) === DASH;
      const stop = scan(i, custom);
      if (stop < n && css.charCodeAt(stop) === LBRACE) {
        const rule = parseStyleRule(i, stop);
        rules.push(rule);
        i = rule.end;
        continue;
      }
      const text = css.slice(i, stop);
      const colon = text.indexOf(":");
      if (colon > 0) {
        const property = text.slice(0, colon).trim();
        let raw = text.slice(colon + 1);
        let important = false;
        const m = raw.includes("!") ? IMPORTANT_RE.exec(raw) : null;
        if (m) {
          important = true;
          raw = raw.slice(0, m.index);
        }
        decls.push({
          property,
          raw: custom ? raw : raw.trim(),
          important,
          start: i,
          end: stop,
        });
      }
      i = stop < n && css.charCodeAt(stop) === SEMI ? stop + 1 : stop;
    }
  }

  // Skip a byte-order mark: decoders strip it, `readFileSync` doesn't.
  return readRuleList(css.charCodeAt(0) === 0xfeff ? 1 : 0, false).nodes;
}

export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++)
    if (text.charCodeAt(i) === LF) starts.push(i + 1);
  return starts;
}

/** Offset -> 1-based line, 0-based column. */
export function locator(css: string): (offset: number) => {
  line: number;
  column: number;
} {
  const starts = lineStarts(css);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - starts[lo] };
  };
}

// Comments dropped, whitespace collapsed (and dropped next to `,` `(` `)` and
// after `:` in parens). Strings stay.
export function canonicalText(raw: string): string {
  // Verbatim runs are copied as slices; whitespace and comments end them.
  const n = raw.length;
  let out = "";
  let start = 0;
  let pendingWs = false;
  let depth = 0;
  let i = 0;
  while (i < n) {
    const c = raw.charCodeAt(i);
    const comment = c === SLASH && raw.charCodeAt(i + 1) === STAR;
    if (comment || isWs(c)) {
      if (start < i) out += raw.slice(start, i);
      i = comment ? commentEnd(raw, i) : i + 1;
      pendingWs = true;
      start = i;
      continue;
    }
    if (isQuote(c)) {
      const j = stringEnd(raw, i);
      if (pendingWs && out && !NO_WS_AFTER.has(out.charCodeAt(out.length - 1)))
        out += " ";
      pendingWs = false;
      i = j + 1;
      continue;
    }
    if (c === LPAREN) depth++;
    else if (c === RPAREN && depth > 0) depth--;
    if (pendingWs && out) {
      const prev = out.charCodeAt(out.length - 1);
      const dropBefore =
        c === COMMA || c === RPAREN || (depth > 0 && c === COLON);
      const noWsAfter = NO_WS_AFTER.has(prev) || (prev === COLON && depth > 0);
      if (!dropBefore && !noWsAfter) out += " ";
    }
    pendingWs = false;
    i += c === BACKSLASH && i + 1 < n ? 2 : 1;
  }
  return start < n ? out + raw.slice(start) : out;
}

const NO_WS_AFTER = new Set([COMMA, LPAREN]);

const COMPARISON = new Set([LT, GT, EQ]);
const CONDITION_SPACING_RE = /\)[a-z]|[<>=]/i;

// After `canonicalText`: a space between `)` and a keyword (`) and (`), none
// around a range operator (`(width>=42rem)`), as Chrome serializes it.
export function canonicalCondition(text: string): string {
  if (!CONDITION_SPACING_RE.test(text)) return text;
  let out = "";
  let afterComparison = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (isQuote(c) || c === BACKSLASH) {
      const end = c === BACKSLASH ? i + 1 : stringEnd(text, i);
      out += text.slice(i, end + 1);
      i = end;
      afterComparison = false;
      continue;
    }
    if (
      c === SPACE &&
      afterComparison !== COMPARISON.has(text.charCodeAt(i + 1))
    )
      continue;
    out += text[i];
    afterComparison = COMPARISON.has(c);
    if (c === RPAREN && ASCII_LETTER_RE.test(text[i + 1] ?? "")) out += " ";
  }
  return out;
}

const ASCII_LETTER_RE = /^[a-z]$/i;
