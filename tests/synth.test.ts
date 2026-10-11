// Synthesized DOM for confirming cascade flips: candidate trees on which one
// element (data-cr-target) matches both selectors.

import { synthesize, type Tree, vocabularyOf } from "../src/core/synth";

const html = ([tag, attrs, children]: Tree): string => {
  const a = Object.entries(attrs)
    .map(([k, v]) => (v ? ` ${k}="${v}"` : ` ${k}`))
    .join("");
  return `<${tag}${a}>${children.map(html).join("")}</${tag}>`;
};
const body = (t: Tree) => html(t[2][1]);

describe("synthesize", () => {
  it("merges the subjects and the levels both selectors have", () => {
    expect(synthesize(".a .t", ".b>.t.u").map(body)).toEqual([
      '<body><div class="a b"><div class="t u" data-cr-target></div></div></body>',
      '<body><div class="a"><div class="b"><div class="t u" data-cr-target></div></div></div></body>',
      '<body><div class="b"><div class="a"><div class="t u" data-cr-target></div></div></div></body>',
    ]);
  });

  it("keeps siblings beside the element they precede", () => {
    expect(body(synthesize(".w .x~.t", ".v .t")[0])).toBe(
      '<body><div class="w"><div class="v"><div class="x"></div><div class="t" data-cr-target></div></div></div></body>',
    );
  });

  it("sets attributes, ids and tags, and gives up on two tags or ids", () => {
    expect(body(synthesize("tr[data-child-row] td", "#a.t")[0])).toBe(
      '<body><tr data-child-row><td id="a" class="t" data-cr-target></td></tr></body>',
    );
    expect(synthesize("p.t", "span.t")).toEqual([]);
    expect(synthesize("#a", "#b")).toEqual([]);
  });

  it("puts html and body requirements on the page's own", () => {
    const [tree] = synthesize("html[theme=g100] .t", "body.x .t");
    expect(tree[1]).toEqual({ theme: "g100" });
    expect(tree[2][1][1]).toEqual({ class: "x" });
  });
});

it("vocabularyOf names the classes and attributes a selector needs", () => {
  expect(vocabularyOf(".a[data-x=1] > .b:hover")).toEqual([
    ".a",
    "[data-x]",
    ".b",
  ]);
});
