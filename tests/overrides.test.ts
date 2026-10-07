import { deadDeclarations } from "crassus";
import { covers } from "../src/core/overrides";

const dead = (css: string) =>
  deadDeclarations(css).map((d) => `${d.selector} ${d.property}:${d.value}`);

describe("deadDeclarations", () => {
  it("flags a declaration a later identical selector always overrides", () => {
    expect(dead(".a { color: red; top: 0 } .a { color: blue }")).toEqual([
      ".a color:red",
    ]);
  });

  it("needs every selector of the list to be overridden", () => {
    expect(dead(".a, .b { color: red } .a { color: blue }")).toEqual([]);
    expect(
      dead(".a, .b { color: red } .a { color: blue } .b { color: green }"),
    ).toEqual([".a,.b color:red"]);
  });

  it("keeps contexts apart", () => {
    const css =
      ".a { color: red } @media (min-width: 1px) { .a { color: blue } }";
    expect(dead(css)).toEqual([]);
  });

  it("respects importance", () => {
    expect(dead(".a { color: red !important } .a { color: blue }")).toEqual([
      ".a color:blue",
    ]);
    expect(dead(".a { color: red } .a { color: blue !important }")).toEqual([
      ".a color:red",
    ]);
  });

  it("a later shorthand kills its longhands, not the reverse", () => {
    expect(dead(".a { padding-top: 1px } .a { padding: 0 }")).toEqual([
      ".a padding-top:1px",
    ]);
    expect(dead(".a { padding: 0 } .a { padding-top: 1px }")).toEqual([]);
    expect(covers("border", "border-radius")).toBe(false);
  });

  it("covers every shorthand the engine knows", () => {
    for (const [later, earlier] of [
      ["font", "font-weight"],
      ["font", "line-height"],
      ["gap", "row-gap"],
      ["grid-area", "grid-column-end"],
      ["grid", "grid-template-areas"],
      ["place-items", "justify-items"],
      ["animation", "animation-name"],
      ["mask", "mask-image"],
      ["list-style", "list-style-type"],
      ["columns", "column-count"],
      ["border-inline", "border-inline-start-color"],
      ["inset-inline", "inset-inline-end"],
      ["text-decoration", "text-decoration-color"],
      // A shorthand covers the smaller shorthands inside it.
      ["border", "border-top"],
      ["margin", "margin-block"],
    ])
      expect([later, earlier, covers(later, earlier)]).toEqual([
        later,
        earlier,
        true,
      ]);
    expect(covers("font", "font-family-x")).toBe(false);
    expect(covers("border-top", "border")).toBe(false);
  });

  it("treats aliases as fallbacks, not overrides", () => {
    expect(covers("gap", "grid-gap")).toBe(false);
    expect(covers("break-after", "page-break-after")).toBe(false);
    expect(dead(".a { grid-gap: 1px; gap: 1px }")).toEqual([]);
    expect(dead(".a { grid-row-gap: 1px; gap: 1px }")).toEqual([]);
    expect(
      dead(".a { overflow-wrap: anywhere; word-wrap: break-word }"),
    ).toEqual([]);
    // The other way round, the standard declaration is dead.
    expect(dead(".a { row-gap: 1px; grid-gap: 1px }")).toEqual([
      ".a row-gap:1px",
    ]);
  });

  it("flags in-rule repeats except progressive-enhancement fallbacks", () => {
    expect(dead(".a { font-weight: 400; font-weight: var(--w, 400) }")).toEqual(
      [".a font-weight:400"],
    );
    expect(dead(".a { width: -moz-fit-content; width: fit-content }")).toEqual(
      [],
    );
  });

  it("orders by layer: later layers win, unlayered wins over layered", () => {
    expect(
      dead(
        "@layer b, a; @layer a { .a { color: red } } @layer b { .a { color: blue } }",
      ),
    ).toEqual([".a color:blue"]);
    expect(dead(".a { color: red } @layer x { .a { color: blue } }")).toEqual([
      ".a color:blue",
    ]);
    // A layer's own rules beat its sublayers.
    expect(
      dead("@layer a { .a { color: red } @layer b { .a { color: blue } } }"),
    ).toEqual([".a color:blue"]);
    const [d] = deadDeclarations(
      ".a { color: red } @layer x { .a { color: blue } }",
    );
    expect([d.layer, d.by.layer]).toEqual(["x", ""]);
  });

  it("reverses layer order for !important", () => {
    expect(
      dead(
        "@layer a { .a { color: red !important } } @layer b { .a { color: blue !important } } .a { color: green !important }",
      ),
    ).toEqual([".a color:blue", ".a color:green"]);
  });

  it("orders layers by first declaration, including @import layer()", () => {
    expect(
      dead(
        "@import url(x.css) layer(b); @layer a { .a { color: red } } @layer b { .a { color: blue } }",
      ),
    ).toEqual([".a color:blue"]);
    expect(
      dead("@layer a.b { .a { color: red } } @layer a { .a { color: blue } }"),
    ).toEqual([".a color:red"]);
  });

  it("doesn't compare layers whose order depends on a condition", () => {
    // `a` comes first only if the media query matches.
    const css =
      "@media (width > 1px) { @layer a; } @layer b { .a { color: red } } @layer a { .a { color: blue } }";
    expect(dead(css)).toEqual([]);
  });

  it("keeps scopes apart", () => {
    expect(
      dead("@scope (.r) { .a { color: red } } .a { color: blue }"),
    ).toEqual([]);
    expect(
      dead(
        "@scope (.r) { .a { color: red } } @scope (.r) { .a { color: blue } }",
      ),
    ).toEqual([".a color:red"]);
  });

  it("sees through CSS nesting", () => {
    expect(dead(".a { .b { color: red } } .a .b { color: blue }")).toEqual([
      ".a .b color:red",
    ]);
    // Declarations after a nested rule come later than it.
    expect(dead(".a { color: red; & { color: blue } color: green }")).toEqual([
      ".a color:red",
      ".a color:blue",
    ]);
    expect(
      dead(
        ".a { @media print { color: red } } @media print { .a { color: blue } }",
      ),
    ).toEqual([".a color:red"]);
  });

  it("ignores keyframe selectors", () => {
    const css =
      "@keyframes x { to { top: 0 } } @keyframes x { to { top: 1px } }";
    expect(dead(css)).toEqual([]);
  });

  it("block-axis logical properties share a slot with their physical twin", () => {
    expect(dead(".a { inset-block-start: 0; top: 1px }")).toEqual([
      ".a inset-block-start:0",
    ]);
    expect(dead(".a { height: 1px } .a { block-size: 2px }")).toEqual([
      ".a height:1px",
    ]);
    expect(dead(".a { margin-top: 1px } .a { margin-block: 0 }")).toEqual([
      ".a margin-top:1px",
    ]);
    expect(covers("border-block-end-color", "border-bottom-color")).toBe(true);
  });

  it("leaves the inline axis alone, since it maps by dir", () => {
    expect(dead(".a { margin-inline-start: 0; margin-left: 1px }")).toEqual([]);
    expect(covers("inset-inline-end", "right")).toBe(false);
  });

  it("keeps overflow: hidden as the fallback for overflow: clip", () => {
    expect(dead(".a { overflow: hidden; overflow: clip }")).toEqual([]);
    expect(dead(".a { overflow: hidden; overflow: auto }")).toEqual([
      ".a overflow:hidden",
    ]);
  });
});
