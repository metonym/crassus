// Character codes and scanning helpers shared by the parsers.

const TAB = 9;
export const LF = 10;
const FF = 12;
const CR = 13;
const SPACE = 32;
export const DQUOTE = 34;
export const HASH = 35;
export const AMP = 38;
export const SQUOTE = 39;
export const LPAREN = 40;
export const RPAREN = 41;
export const STAR = 42;
export const PLUS = 43;
export const COMMA = 44;
export const DASH = 45;
export const DOT = 46;
export const SLASH = 47;
export const COLON = 58;
export const SEMI = 59;
export const GT = 62;
export const AT = 64;
export const LBRACKET = 91;
export const BACKSLASH = 92;
export const RBRACKET = 93;
export const LBRACE = 123;
export const PIPE = 124;
export const RBRACE = 125;
export const TILDE = 126;

export const isWs = (c: number) =>
  c === SPACE || c === LF || c === TAB || c === CR || c === FF;

export const isQuote = (c: number) => c === DQUOTE || c === SQUOTE;

/** Index of the quote closing the string that opens at `i` (past the end if unclosed). */
export function stringEnd(text: string, i: number): number {
  const quote = text.charCodeAt(i);
  let j = i + 1;
  while (j < text.length && text.charCodeAt(j) !== quote)
    j += text.charCodeAt(j) === BACKSLASH ? 2 : 1;
  return j;
}
