// What a stylesheet change can reach: `compare` skips pages and elements
// outside it, so it must be a superset of what can change.

import {
  changedRules,
  impactProperties,
  relaxSelector,
} from "../src/core/impact";

describe("relaxSelector", () => {
  it.each([
    // States and pseudo-elements: the element in any state.
    [".a:hover::before", ".a"],
    ["input:checked+label", "input+label"],
    ["::placeholder", "*"],
    [".a:focus-visible .b:active", ".a .b"],
    // A negation that held a state goes whole; an exact one stays.
    [".a:not(:focus) .b", ".a .b"],
    [".a:not(.b)", ".a:not(.b)"],
    [".a:not([disabled])", ".a:not([disabled])"],
    // Matched in place: relaxed inside.
    [":is(.a:hover,.b)>.c", ":is(.a,.b)>.c"],
    [":where(.a:checked) .b", ":where(.a) .b"],
    [".a:has(:checked)", ".a"],
    [".a:has(>.b)", ".a:has(>.b)"],
    // Structure a static DOM decides.
    ["li:nth-child(2n+1)", "li:nth-child(2n+1)"],
    [":root .a:first-child", ":root .a:first-child"],
    ["li:nth-child(odd of .x:hover)", "li"],
    // Text, values and document state aren't in the page index.
    ["p:empty", "p"],
    ["a:target", "a"],
    ["[dir=rtl] .a:dir(rtl)", "[dir=rtl] .a"],
  ])("%s -> %s", (selector, relaxed) => {
    expect(relaxSelector(selector)).toBe(relaxed);
  });
});

describe("changedRules", () => {
  const props = (base: string, head: string) =>
    Object.fromEntries(
      changedRules(base, head).selectors.map((s) => [s.selector, s.properties]),
    );

  it("finds nothing between equal sheets", () => {
    const css = ".a { color: red; } .b:hover { padding: 0; }";
    expect(changedRules(css, css)).toEqual({
      everything: null,
      selectors: [],
      containers: false,
    });
  });

  it("names the declarations an edit in place changed", () => {
    expect(
      props(
        ".a { font-size: 1rem; color: red; padding: 0; } .b { color: red; }",
        ".a { font-size: 1rem; color: blue; padding: 0; } .b { color: red; }",
      ),
    ).toEqual({ ".a": ["color"] });
    // Reordered declarations can change which wins: all of them.
    expect(
      props(
        ".a { padding: 0; padding-left: 1px; }",
        ".a { padding-left: 1px; padding: 0; }",
      ),
    ).toEqual({ ".a": ["padding", "padding-left"] });
  });

  it("takes rules on one side whole, under their relaxed selector", () => {
    const r = changedRules(
      ".a:hover::after { content: 'x'; top: 0; } .b { color: red; }",
      ".b { color: red; }",
    );
    expect(r.selectors).toEqual([
      {
        selector: ".a",
        sources: [".a:hover::after"],
        properties: ["content", "top"],
      },
    ]);
  });

  it("takes a rule that moved against the others whole", () => {
    expect(
      props(
        ".a { color: red; } .b { color: blue; } .c { top: 0; }",
        ".b { color: blue; } .c { top: 0; } .a { color: red; }",
      ),
    ).toEqual({ ".a": ["color"] });
  });

  it("splits a selector list into its selectors", () => {
    expect(
      props(".a, .b { color: red; }", ".a, .b, .c:focus { color: red; }"),
    ).toEqual({ ".c": ["color"] });
  });

  it("charges a changed keyframe to the rules that run it", () => {
    const css = (from: string) =>
      `@keyframes k { from { opacity: ${from}; } } .s { animation: k 1s; } .t { animation-name: other; }`;
    expect(props(css("0"), css("0.5"))).toEqual({ ".s": ["opacity"] });
  });

  it("gives up on changes outside style rules", () => {
    expect(
      changedRules(
        "@font-face { font-family: x; src: url(a.woff); } .a { color: red; }",
        "@font-face { font-family: x; src: url(b.woff); } .a { color: red; }",
      ).everything,
    ).toBe("an at-rule other than a style rule's group changed");
    expect(
      changedRules(
        "@layer a, b; @layer a { .x { color: red; } }",
        "@layer b, a; @layer a { .x { color: red; } }",
      ).everything,
    ).toBe("the cascade layer order changed");
    // Group rules are diffed rule by rule.
    expect(
      props(
        "@media (width >= 1px) { .a { color: red; } }",
        "@media (width >= 2px) { .a { color: red; } }",
      ),
    ).toEqual({ ".a": ["color"] });
    expect(
      changedRules("@container (width > 1px) { .a {} }", "").containers,
    ).toBe(true);
  });
});

describe("impactProperties", () => {
  const universe = [
    "color",
    "fill",
    "outline-color",
    "border-top-color",
    "border-top-width",
    "border-top-style",
    "padding-top",
    "padding-block-start",
    "width",
    "top",
    "display",
    "opacity",
  ];

  it("follows color to what can use currentColor, with no layout", () => {
    const r = impactProperties(["color"], universe);
    expect(r.layout).toBe(false);
    expect(r.properties).toEqual(
      expect.arrayContaining([
        "color",
        "fill",
        "outline-color",
        "border-top-color",
      ]),
    );
    expect(r.properties).not.toContain("padding-top");
    expect(r.properties).not.toContain("width");
  });

  it("adds logical twins, and layout values when a box can move", () => {
    const r = impactProperties(["padding-top"], universe);
    expect(r.layout).toBe(true);
    expect(r.properties).toEqual(
      expect.arrayContaining([
        "padding-top",
        "padding-block-start",
        "width",
        "top",
      ]),
    );
    expect(impactProperties(["opacity"], universe).layout).toBe(false);
  });

  it("adds the width a border style sets", () => {
    expect(
      impactProperties(["border-top-style"], universe).properties,
    ).toContain("border-top-width");
  });

  it("reads everything for what other values are read through", () => {
    for (const p of ["font-size", "--token", "writing-mode", "line-height"])
      expect(impactProperties([p], universe).properties).toBeNull();
  });
});
