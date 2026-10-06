import { parseRules } from "crassus";
import { coMatchable } from "../src/core/cascade";
import { canonicalText, MAX_DEPTH, parseStylesheet } from "../src/core/parse";
import {
  attrConstraint,
  normalizeSelector,
  parseComplex,
  parseSelectorList,
  resolveNested,
  serialize,
  specificity,
} from "../src/core/selector";

const spec = (s: string) => specificity(parseComplex(s));

describe("selector specificity (fixes vs css-tree port)", () => {
  it("treats legacy single-colon pseudo-elements as pseudo-elements", () => {
    expect(spec(".a:after")).toEqual([0, 1, 1]);
    expect(spec(".a:first-line")).toEqual([0, 1, 1]);
    const [a, b] = parseRules(".a:after { color: red } .a { color: blue }");
    expect(a.subject.pseudoElement).toBe("after");
    expect(coMatchable(a, b)).toBe(false);
  });

  it("adds the `of S` argument of :nth-child", () => {
    expect(spec(":nth-child(2n+1 of .a.b)")).toEqual([0, 3, 0]);
    expect(spec(":nth-child(odd)")).toEqual([0, 1, 0]);
  });

  it("follows Selectors 4 for :is/:not/:has/:where and ::slotted", () => {
    expect(spec(":is(#a, .b) .c")).toEqual([1, 1, 0]);
    expect(spec(":where(#a) .c")).toEqual([0, 1, 0]);
    expect(spec("a:has(> img.x)")).toEqual([0, 1, 2]);
    expect(spec("::slotted(.a)")).toEqual([0, 1, 1]);
  });

  it("ignores namespaces and handles escapes in class names", () => {
    expect(spec("svg|rect")).toEqual([0, 0, 1]);
    expect(spec(".md\\:flex")).toEqual([0, 1, 0]);
    expect(normalizeSelector(".a  >  .b ,  .c   .d")).toBe(".a>.b,.c .d");
  });
});

describe("attribute selectors", () => {
  it("keeps the space before a flag on an unquoted value", () => {
    expect(normalizeSelector("[type = text  i]")).toBe("[type=text i]");
    expect(normalizeSelector('[a = "x"  s]')).toBe('[a="x"s]');
  });

  it("reads the name and exact value", () => {
    expect(attrConstraint('[data-State="open"]')).toEqual({
      name: "data-state",
      value: "open",
    });
    expect(attrConstraint("[ns|a=b i]")).toEqual({ name: "a", value: "b" });
    expect(attrConstraint("[a^=b]")).toEqual({ name: "a", value: null });
    expect(attrConstraint("[hidden]")).toEqual({ name: "hidden", value: null });
  });
});

describe("parser robustness", () => {
  it("keeps strings, comments and parens intact while scanning", () => {
    const [rule] = parseStylesheet(
      '.a { content: "}{;"; background: url(data:image/svg+xml;utf8,<svg/>); /* } */ color: red !important }',
    );
    expect(rule.kind).toBe("rule");
    if (rule.kind !== "rule") return;
    expect(rule.decls.map((d) => d.property)).toEqual([
      "content",
      "background",
      "color",
    ]);
    expect(rule.decls[2].important).toBe(true);
  });

  it("keeps custom property values raw, including braces", () => {
    const [r] = parseRules(
      ".a { --x: { a: b }; --y: var(--e,/*!*/ /*!*/); color: red }",
    );
    expect(r.decls.get("--x")).toBe("{ a: b }");
    expect(r.decls.get("--y")).toBe("var(--e,/*!*/ /*!*/)");
    expect(r.decls.get("color")).toBe("red");
  });

  it("canonicalizes media preludes", () => {
    expect(canonicalText("screen and ( min-width : 42rem ) , print")).toBe(
      "screen and (min-width:42rem),print",
    );
  });

  it("parses declaration at-rules and keyframes without leaking rules", () => {
    const rules = parseRules(
      "@font-face { font-family: X; src: url(x.woff2) } @keyframes k { 0% { opacity: 0 } to { opacity: 1 } } .a { color: red }",
    );
    expect(rules.map((r) => `${r.context}|${r.selector}`)).toEqual([
      "@keyframes k|0%",
      "@keyframes k|to",
      "|.a",
    ]);
  });
});

describe("resolveNested", () => {
  const resolve = (sel: string, parent: string) => {
    const c = resolveNested(parseComplex(sel), parseSelectorList(parent));
    return [serialize(c), specificity(c).join(",")];
  };

  it("adds the implicit `&` and splices a single parent", () => {
    expect(resolve(".b", ".a")).toEqual([".a .b", "0,2,0"]);
    expect(resolve("> .b", ".a .x")).toEqual([".a .x>.b", "0,3,0"]);
    expect(resolve("&.b:hover", "a.a")).toEqual(["a.a.b:hover", "0,3,1"]);
    expect(resolve("&", ".a")).toEqual([".a", "0,1,0"]);
  });

  it("uses :is() for parent lists and `&` anywhere but the start", () => {
    // :is() takes the heaviest parent, as browsers do.
    expect(resolve(".b", ".a, #q")).toEqual([":is(.a,#q) .b", "1,1,0"]);
    expect(resolve(".b &", ".a")).toEqual([".b :is(.a)", "0,2,0"]);
    expect(resolve("& + &", ".a")).toEqual([":is(.a)+:is(.a)", "0,2,0"]);
    expect(resolve(":not(&)", ".a")).toEqual([":not(:is(.a))", "0,1,0"]);
    expect(resolve(".b", ".a::before")).toEqual([
      ":is(.a::before) .b",
      "0,2,1",
    ]);
  });
});

describe("nested at-rules", () => {
  it("parses declarations in a group rule nested in a style rule", () => {
    const [rule] = parseStylesheet(
      ".a { @media print { color: red; .b { top: 0 } } }",
    );
    if (rule.kind !== "rule") throw new Error("expected a style rule");
    const [media] = rule.rules;
    if (media.kind !== "at") throw new Error("expected an at-rule");
    expect(media.decls?.map((d) => d.property)).toEqual(["color"]);
    expect(media.rules?.length).toBe(1);
  });
});

describe("error recovery, as browsers do it", () => {
  const selectors = (css: string) => parseRules(css).map((r) => r.selector);

  it("drops the rule a stray `;` or top-level `}` ends up in", () => {
    expect(selectors(".x{} ; .a{color:red} .b{color:blue}")).toEqual([
      ".x",
      ".b",
    ]);
    expect(selectors(".x{} } .a{color:red} .b{color:blue}")).toEqual([
      ".x",
      ".b",
    ]);
    expect(selectors(".x{} } @media all { .a{} } .b{}")).toEqual([".x", ".b"]);
    expect(selectors("@media all { ; .a{} .b{} }")).toEqual([".b"]);
    // Inside a group rule, `}` just closes it.
    expect(selectors("@media all { } .a{} } .b{}")).toEqual([".a"]);
  });

  it("skips a byte-order mark", () => {
    expect(selectors("\uFEFF@media all { .a{} }")).toEqual([".a"]);
  });

  it("drops unknown at-rules, and their declarations rejoin the rule", () => {
    expect(selectors("@foo bar { .a{} } .b{}")).toEqual([".b"]);
    const [p] = parseRules(".p { color: red; @foo { top: 0 } left: 0 }");
    expect(p.declBlock).toBe("color:red;left:0");
    // Firefox applies @-moz-document.
    expect(selectors("@-moz-document url-prefix() { .a{} }")).toEqual([".a"]);
  });

  it("skips blocks nested past MAX_DEPTH instead of overflowing", () => {
    const deep = (n: number) =>
      `${"@media all{".repeat(n)}.a{}${"}".repeat(n)}.b{}`;
    expect(selectors(deep(100))).toEqual([".a", ".b"]);
    expect(selectors(deep(MAX_DEPTH + 1))).toEqual([".b"]);
    expect(() =>
      parseRules(`${":is(".repeat(5000)}.a${")".repeat(5000)}{}`),
    ).not.toThrow();
  });
});
