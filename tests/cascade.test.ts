import { parseRules } from "crassus";
import {
  coMatchable,
  conflictingProps,
  histogram,
  histogramByFile,
  matchContextMoves,
  wins,
} from "../src/core/cascade";

const rules = (css: string) => parseRules(css);
const one = (css: string) => rules(css)[0];

describe("parseRules", () => {
  it("computes specificity per selector in a list", () => {
    const [a, b, c, d] = rules(
      ".x, .x.y:hover, button.x::before, .x:not(.y):not(.z)  { color: red }",
    );
    expect(a.specificity).toEqual([0, 1, 0]);
    expect(b.specificity).toEqual([0, 3, 0]);
    expect(c.specificity).toEqual([0, 1, 2]);
    expect(d.specificity).toEqual([0, 3, 0]);
  });

  it(":where adds nothing, :is/:not take the heaviest argument", () => {
    expect(one(":where(.a.b) .c { color: red }").specificity).toEqual([
      0, 1, 0,
    ]);
    expect(one(":is(.a, .b.c) { color: red }").specificity).toEqual([0, 2, 0]);
    expect(one("#id { color: red }").specificity).toEqual([1, 0, 0]);
  });

  it("records media context, order, and important declarations", () => {
    const [plain, inMedia] = rules(
      ".x { color: red } @media (any-hover: hover) { .x:hover { color: blue !important; padding: 0 } }",
    );
    expect(plain.context).toBe("");
    expect(inMedia.context).toBe("@media (any-hover:hover)");
    expect(inMedia.order).toBeGreaterThan(plain.order);
    expect(inMedia.decls.get("color")).toBe("blue !important");
    expect(inMedia.declBlock).toBe("color:blue !important;padding:0");
  });

  it("subject is the last compound only", () => {
    const r = one(".a .b:not(.c)::after { color: red }");
    expect([...r.subject.classes]).toEqual(["b"]);
    expect([...r.subject.negated]).toEqual(["c"]);
    expect(r.subject.pseudoElement).toBe("after");
  });

  it("flags a type-qualified class compound anywhere in the selector", () => {
    const r = (sel: string) => one(`${sel} { color: red }`).subject.qualified;
    expect(r("a.x")).toBe(true);
    expect(r("tr.x td")).toBe(true);
    expect(r(".x a")).toBe(false);
    expect(r(".x > .y")).toBe(false);
    expect(r("*.x")).toBe(false);
  });

  it("separates layer and scope from the condition context", () => {
    const [a, b, c] = rules(
      "@layer base, comp; @media print { @layer comp { .x { color: red } } } @layer base.reset { .y { color: red } } @scope (.r) to (.s) { .z { color: red } }",
    );
    expect([a.context, a.layer, a.scope]).toEqual(["@media print", "comp", ""]);
    expect([b.layer, c.layer, c.scope]).toEqual([
      "base.reset",
      "",
      "@scope (.r) to (.s)",
    ]);
    // base.reset < base < comp < unlayered
    expect(b.layerRank).toBeLessThan(a.layerRank);
    expect(a.layerRank).toBeLessThan(c.layerRank);
    expect(a.key).toBe("@media print / @layer comp .x color:red");
  });

  it("flattens CSS nesting in source order", () => {
    const list = rules(
      ".p { color: red; .x { color: blue } top: 0; @media print { left: 0; & > .y { right: 0 } } }",
    );
    expect(
      list.map((r) => [r.selector, r.context, r.declBlock, r.order]),
    ).toEqual([
      [".p", "", "color:red", 0],
      [".p .x", "", "color:blue", 1],
      // Declarations after a nested rule are a rule of their own.
      [".p", "", "top:0", 2],
      [".p", "@media print", "left:0", 3],
      [".p>.y", "@media print", "right:0", 4],
    ]);
  });

  it("gives nested declarations the specificity of `&`", () => {
    const [a, b, , nested] = rules(
      ".p, #q { color: red; & .x { top: 0 } color: blue }",
    );
    expect([a.specificity, b.specificity]).toEqual([
      [0, 1, 0],
      [1, 0, 0],
    ]);
    expect([nested.selector, nested.specificity]).toEqual([
      ":is(.p,#q)",
      [1, 0, 0],
    ]);
  });

  it("records nested selector positions", () => {
    const [, x, decls] = parseRules(
      ".p {\n  .x { top: 0 }\n  left: 0;\n}",
      true,
    );
    expect(x.loc).toEqual({ line: 2, column: 2 });
    expect(decls.loc).toEqual({ line: 3, column: 2 });
  });

  it("names anonymous layers", () => {
    const [a] = rules("@layer { @layer x { .a { color: red } } }");
    expect(a.layer).toBe("<anonymous>.x");
  });

  it("records selector positions on request", () => {
    const [a, b] = parseRules(
      ".a { color: red }\n  .b,\n.c { color: blue }",
      true,
    );
    expect(a.loc).toEqual({ line: 1, column: 0 });
    expect(b.loc).toEqual({ line: 2, column: 2 });
    expect(one(".a { color: red }").loc).toBeUndefined();
  });
});

describe("histogram", () => {
  const css =
    ".a, .a.b, a.a.b.c, .a.b.c.d:hover, .a .b .c .d .e { color: red }";

  it("buckets by class tier and counts qualified compounds", () => {
    const h = histogram(rules(css));
    expect(h.selectors).toBe(5);
    expect(h.classes).toEqual([0, 1, 1, 1, 2]);
    expect(h.qualified).toBe(1);
    expect(h.max).toEqual([0, 5, 0]);
  });

  it("groups by source file, unplaced rules under ?", () => {
    const list = rules(css);
    const byFile = histogramByFile(list, (r) =>
      r.selector.startsWith(".a.b") ? "x.scss" : undefined,
    );
    expect([...byFile.keys()]).toEqual(["?", "x.scss"]);
    expect(byFile.get("x.scss")?.selectors).toBe(2);
    expect(byFile.get("?")?.selectors).toBe(3);
  });
});

describe("coMatchable", () => {
  const r = (sel: string) => one(`${sel} { color: red }`);

  it("shares a subject class", () => {
    expect(coMatchable(r(".a .x"), r(".x.y"))).toBe(true);
    expect(coMatchable(r(".x"), r(".y"))).toBe(false);
  });

  it("a negated class excludes the other's required class", () => {
    expect(coMatchable(r(".x:not(.y)"), r(".x.y"))).toBe(false);
    expect(coMatchable(r(".x:not(.d) ~ .y"), r(".x.d ~ .y"))).toBe(false);
    expect(coMatchable(r(".x:not(.d) ~ .y"), r(".x ~ .y"))).toBe(true);
  });

  it("pseudo-elements and media contexts must agree", () => {
    expect(coMatchable(r(".x::before"), r(".x"))).toBe(false);
    const [a, b] = rules(
      ".x { color: red } @media print { .x { color: blue } }",
    );
    expect(coMatchable(a, b)).toBe(false);
  });

  it("rules in different layers or scopes can co-match", () => {
    const [a, b, c] = rules(
      "@layer x { .x { color: red } } .x { color: blue } @scope (.r) { .x { color: green } }",
    );
    expect(coMatchable(a, b)).toBe(true);
    expect(coMatchable(b, c)).toBe(true);
  });

  it("models attribute subjects", () => {
    const { attrs, negatedAttrs } = r(
      '[data-scope="menu"] [data-part=item][hidden]:not([data-state=open]):not([disabled])',
    ).subject;
    expect([...attrs]).toEqual([
      ["data-part", "item"],
      ["hidden", null],
    ]);
    expect([...negatedAttrs]).toEqual(["data-state=open", "disabled"]);
  });

  it("pairs class-less subjects through a shared attribute", () => {
    expect(
      coMatchable(r("[data-part=item]"), r("[data-part=item]:hover")),
    ).toBe(true);
    expect(coMatchable(r("[data-part=item]"), r(".x[data-part=item]"))).toBe(
      true,
    );
    expect(coMatchable(r("[data-part=item]"), r("[data-state=open]"))).toBe(
      false,
    );
    expect(coMatchable(r("[data-part=item]"), r(".x"))).toBe(false);
    expect(coMatchable(r("[data-part=item]"), r("li"))).toBe(false);
    expect(coMatchable(r("li[data-part=item]"), r("a[data-part=item]"))).toBe(
      false,
    );
  });

  it("different exact values or a negated attribute exclude each other", () => {
    expect(coMatchable(r("[data-state=open]"), r("[data-state=closed]"))).toBe(
      false,
    );
    expect(
      coMatchable(r(".x[data-state=open]"), r(".x[data-state=closed]")),
    ).toBe(false);
    expect(coMatchable(r("[data-state=open]"), r("[data-state]"))).toBe(true);
    expect(coMatchable(r("[type=text]"), r("[type=TEXT]"))).toBe(true);
    expect(coMatchable(r(".x:not([disabled])"), r(".x[disabled]"))).toBe(false);
    expect(
      coMatchable(r(".x:not([data-state=open])"), r(".x[data-state=open]")),
    ).toBe(false);
    expect(
      coMatchable(r(".x:not([data-state=open])"), r(".x[data-state=closed]")),
    ).toBe(true);
    expect(coMatchable(r(".x:not([a][b])"), r(".x[a]"))).toBe(true);
  });

  it("type-only subjects pair only on same type and a shared class", () => {
    expect(coMatchable(r("tr"), r(".x"))).toBe(false);
    expect(coMatchable(r("tr"), r("tbody tr"))).toBe(true);
    expect(coMatchable(r(".a svg"), r(".a:hover > svg"))).toBe(true);
    expect(coMatchable(r(".a svg"), r(".b svg"))).toBe(false);
    expect(coMatchable(r(".a svg"), r(".a path"))).toBe(false);
  });
});

describe("matchContextMoves", () => {
  it("pairs a dropped and a new rule sharing selector + decls across contexts", () => {
    const removed = rules(".x { color: red }");
    const added = rules("@media (any-hover: hover) { .x { color: red } }");
    const moves = matchContextMoves(removed, added);
    expect(moves.size).toBe(1);
    expect(moves.get(added[0])).toBe(removed[0]);
    expect(removed).toEqual([]);
    expect(added).toEqual([]);
  });

  it("pairs a rule that moved between layers", () => {
    const removed = rules("@layer a { .x { color: red } }");
    const added = rules("@layer b { .x { color: red } }");
    expect(matchContextMoves(removed, added).size).toBe(1);
  });

  it("does not pair rules with the same context, or different selectors/decls", () => {
    const removed = rules(".x { color: red } .y { color: red }");
    const added = rules(
      ".x { color: red } @media print { .y { color: blue } }",
    );
    const moves = matchContextMoves(removed, added);
    expect(moves.size).toBe(0);
    expect(removed.length).toBe(2);
    expect(added.length).toBe(2);
  });

  it("leaves unmatched added rules in place", () => {
    const removed = rules(".x { color: red }");
    const added = rules(
      "@media print { .x { color: red } } .z { color: green }",
    );
    const moves = matchContextMoves(removed, added);
    expect(moves.size).toBe(1);
    expect(added).toEqual([expect.objectContaining({ selector: ".z" })]);
  });
});

describe("wins", () => {
  it("important beats specificity beats order", () => {
    const [low, high, later, imp] = rules(
      ".a { color: red } .a.b { color: red } .a { color: red } .c { color: red !important }",
    );
    expect(wins(high, low, "color")).toBe(true);
    expect(wins(later, low, "color")).toBe(true);
    expect(wins(low, later, "color")).toBe(false);
    expect(wins(imp, high, "color")).toBe(true);
  });

  it("layer beats specificity, reversed for !important", () => {
    const [late, early, unlayered] = rules(
      "@layer a, b; @layer b { .x { color: red } } @layer a { #id.x { color: red } } .x { color: red }",
    );
    expect(wins(late, early, "color")).toBe(true);
    expect(wins(unlayered, early, "color")).toBe(true);
    const [eImp, lImp, uImp] = rules(
      "@layer a { .x { color: red !important } } @layer b { .x { color: red !important } } .x { color: red !important }",
    );
    expect(wins(eImp, lImp, "color")).toBe(true);
    expect(wins(lImp, uImp, "color")).toBe(true);
    expect(wins(uImp, eImp, "color")).toBe(false);
  });

  it("scoped beats unscoped at equal specificity only", () => {
    const [scoped, plain, heavier, other] = rules(
      "@scope (.r) { .x { color: red } } .x { color: red } .x.y { color: red } @scope (.s) { .x { color: red } }",
    );
    expect(wins(scoped, plain, "color")).toBe(true);
    expect(wins(heavier, scoped, "color")).toBe(true);
    // Different scopes depend on the DOM: source order decides.
    expect(wins(other, scoped, "color")).toBe(true);
  });

  it("conflicting properties include shorthand/longhand pairs", () => {
    const [a, b] = rules(
      ".a { border: 0; padding-left: 1px } .b { border-color: red; margin: 0 }",
    );
    expect(conflictingProps(a, b)).toEqual(["border~border-color"]);
  });
});
