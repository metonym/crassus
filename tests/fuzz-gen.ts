// Seeded stylesheet generator for the fuzz tests: valid building blocks,
// joined with hostile whitespace, comments, strings and stray tokens.

export interface GenOptions {
  /** Nested style rules and group rules inside style rules. */
  nesting: boolean;
  /** Stray `;`/`}`, unknown at-rules, BOM: recovery paths. */
  junk: boolean;
  /** Cut some sheets off at a random point (values may end up invalid). */
  truncate: boolean;
}

export function generator(seed: number, opts: GenOptions) {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  const pick = <T>(items: readonly T[]) =>
    items[Math.floor(rnd() * items.length)];
  const chance = (p: number) => rnd() < p;

  const WS = ["", "", " ", "\n", "\r\n", "\t", "\f", " \n "];
  const COMMENTS = ["/*c*/", "/**/", "/* } { ; */", "/*/*/"];
  const SELECTORS = [
    ".a",
    ".b",
    ".a .b",
    ".a>.b",
    ".a + .b",
    ".a~.b",
    "a.b",
    "#x",
    "*",
    ":root",
    ".a::before",
    ".a:after",
    ".a:hover",
    ".a:not(.b)",
    ":is(.a, .b) .c",
    ":where(.a)",
    '[data-x="{"]',
    "[data-x=y i]",
    "[data-state=open]",
    ".a\\:b",
    ".\\31 0",
    ".a:nth-child(2n + 1 of .b)",
    ".a:has(> .b)",
    "::slotted(.a)",
    ":host(.a)",
    ".a::part(x)",
    "input[type='text' i]",
  ];
  const NESTED = ["&:hover", "& .b", "> .b", ".c &", "&.c", "& + &", ".b"];
  // Values valid for their property, so browsers keep every declaration.
  const LENGTHS = ["0", "1px 2px", "calc((1px + 2px) * 3)", "var(--x, 1px)"];
  const COLORS = ["red", "#fff", "rgb(0 0 0 / 50%)", "var(--x, red)"];
  const PROPS: Record<string, string[]> = {
    color: COLORS,
    COLOR: COLORS,
    padding: LENGTHS,
    "padding-top": ["0", "1px", "calc(1px + 2px)"],
    margin: LENGTHS,
    font: ["12px/1.5 serif", "inherit", "bold 1em 'a;b'"],
    background: [
      "red",
      "url(x.png)",
      "url( 'x' )",
      "url(data:image/svg+xml;charset=utf8,%3Csvg%3E)",
    ],
    content: ["'a;b'", '"}{;"', "'a\\;b'"],
    "--x": [...COLORS, ...LENGTHS, "{a:b}", "{ [ ( ) ] }", " x  y ", "a\\;b"],
    "--Y": ["1", "'x'", "{}"],
  };
  const IMPORTANT = ["", "", "", " !important", "!important", " ! important"];
  const CONDITIONS: [string, string][] = [
    ["media", "(min-width:1px)"],
    ["media", "screen and (width >= 1px)"],
    ["supports", "(display: grid)"],
    ["container", "x (width > 1px)"],
    ["layer", "a"],
    ["layer", "a.b"],
    ["layer", ""],
    ["scope", "(.a) to (.b)"],
    ["starting-style", ""],
  ];

  const comment = () => (chance(0.08) ? pick(COMMENTS) : "");
  const NAMES = Object.keys(PROPS);
  const decl = () => {
    const prop = pick(NAMES);
    const value = `${pick(PROPS[prop])}${pick(IMPORTANT)}`;
    return `${comment()}${pick(WS)}${prop}${pick(WS)}:${pick(WS)}${value}${comment()}`;
  };
  const selectorList = (pool: string[]) => {
    let sel = pick(pool);
    if (chance(0.3)) sel += `,${pick(WS)}${pick(pool)}`;
    if (chance(0.05)) sel = `${pick(COMMENTS)}${sel}`;
    return sel;
  };
  const body = (depth: number, inStyle: boolean): string => {
    const parts: string[] = [];
    const n = Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) {
      const r = rnd();
      if (!opts.nesting || depth > 3 || r < 0.6) {
        parts.push(decl());
        if (chance(0.85) || i < n - 1) parts.push(`${pick(WS)};`);
        if (opts.junk && chance(0.03)) parts.push(";");
      } else if (r < 0.85) {
        parts.push(rule(depth, inStyle));
      } else {
        parts.push(group(depth, true));
      }
    }
    return parts.join("");
  };
  const rule = (depth: number, nested: boolean): string =>
    `${comment()}${pick(WS)}${selectorList(nested ? NESTED : SELECTORS)}${pick(WS)}{${body(depth + 1, true)}${pick(WS)}}`;
  const group = (depth: number, inStyle: boolean): string => {
    // `&` inside a nested @scope is the scope root: not modeled.
    const [name, prelude] = pick(
      inStyle ? CONDITIONS.filter(([n]) => n !== "scope") : CONDITIONS,
    );
    const head = `@${name}${prelude ? ` ${prelude}` : ""}${pick(WS)}`;
    if (name === "layer" && prelude && !inStyle && chance(0.2))
      return `@layer ${prelude}, z;`;
    const inner = inStyle
      ? body(depth + 1, true)
      : Array.from({ length: Math.floor(rnd() * 3) }, () =>
          chance(0.8) ? rule(depth + 1, false) : group(depth + 1, false),
        ).join(pick(WS));
    return `${comment()}${head}{${inner}${pick(WS)}}`;
  };
  const sheet = (): { css: string; truncated: boolean; stray: boolean } => {
    const parts: string[] = [];
    // A top-level `;` or `}`: browsers drop whatever follows up to the next
    // block, at-rules included.
    let stray = false;
    if (chance(0.1))
      parts.push(`@import url(x.css) layer(${pick(["a", "b"])});`);
    const n = 1 + Math.floor(rnd() * 6);
    for (let i = 0; i < n; i++) {
      const r = rnd();
      if (r < 0.65) parts.push(rule(0, false));
      else if (r < 0.9) parts.push(group(0, false));
      else if (r < 0.95)
        parts.push(`@keyframes k { from { top: 0 } 50% { top: 1px } }`);
      else parts.push(pick(COMMENTS));
      if (opts.junk) {
        if (chance(0.03)) {
          parts.push(chance(0.5) ? ";" : "}");
          stray = true;
        }
        if (chance(0.03)) parts.push("@foo bar { .a { color: red } }");
        if (chance(0.03)) parts.push("<!-- -->");
      }
    }
    let css = parts.join(pick(WS)) + pick(WS);
    if (opts.junk && chance(0.02)) css = `﻿${css}`;
    let truncated = false;
    if (opts.truncate && chance(0.03)) {
      css = css.slice(0, Math.floor(rnd() * css.length));
      truncated = true;
    }
    return { css, truncated, stray };
  };
  return sheet;
}

/** Formatting-insensitive: whitespace, quote style, escapes, `::` vs `:`. */
export const loose = (s: string) =>
  s.replace(/[\s"'\\]+/g, "").replace(/::/g, ":");
