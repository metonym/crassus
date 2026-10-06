// Inputs aimed at recursion, quadratic paths and unterminated tokens.
const list = (n: number, f: (i: number) => string, sep = "") =>
  Array.from({ length: n }, (_, i) => f(i)).join(sep);

export const HOSTILE: Record<string, string> = {
  "deep blocks": "a{".repeat(20_000),
  "deep closed blocks": `${".a{".repeat(5000)}color:red${"}".repeat(5000)}`,
  "deep at-rules": "@media all{".repeat(20_000),
  "deep parens in a selector": `${":is(".repeat(20_000)}.a${")".repeat(20_000)}{}`,
  "deep parens in a value": `.a{color:${"(".repeat(100_000)}}`,
  "deep brackets": `.a${"[".repeat(50_000)}{}`,
  "unterminated comment": `.a{color:red}/*${"x".repeat(100_000)}`,
  "unterminated string": `.a{content:"${"x".repeat(100_000)}`,
  "unterminated url": `.a{background:url(${"x".repeat(100_000)}`,
  "backslash at the end": ".a\\",
  "many selectors": `${list(50_000, (i) => `.s${i}`, ",")}{color:red}`,
  "many declarations": `:root{${list(50_000, (i) => `--v${i}:${i}`, ";")}}`,
  "repeated declarations": `.a{${"color:red;".repeat(50_000)}}`,
  "many semicolons": `.a{${";".repeat(100_000)}}`,
  "many stray braces": "}".repeat(100_000),
  "many at-signs": "@".repeat(100_000),
  "null and control characters": ".a\u0000{color:\u0000red;\u0001}",
  "lone surrogates": ".\ud800{content:'\udfff'}",
  "deep nesting with selector lists": `${".a,.b{".repeat(200)}color:red${"}".repeat(200)}`,
  "deep ampersands": `.a{${"&{".repeat(2000)}color:red${"}".repeat(2000)}}`,
  "deep layers": `${"@layer x{".repeat(5000)}.a{}${"}".repeat(5000)}`,
  "long dotted layer name": `@layer ${list(10_000, (i) => `l${i}`, ".")}{.a{}}`,
  "many layer statements": list(20_000, (i) => `@layer l${i};`),
};
