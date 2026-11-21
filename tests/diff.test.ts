import { cascadeDiff, parseRules } from "crassus";

const flips = (base: string, head: string) =>
  cascadeDiff(parseRules(base), parseRules(head)).flips.map(
    (f) => `${f.rule.selector} ${f.after} ${f.prop} vs ${f.other.selector}`,
  );

describe("cascadeDiff", () => {
  it("reports a rewrite that flips the winner", () => {
    expect(
      flips(
        ".a .x { color: red } .x { color: blue }",
        ":where(.a) .x { color: red } .x { color: blue }",
      ),
    ).toEqual([":where(.a) .x loses color vs .x"]);
  });

  it("sees flips between attribute subjects", () => {
    expect(
      flips(
        "[data-part=item][data-state=open] { color: red } [data-part=item] { color: blue }",
        ":where([data-part=item])[data-state=open] { color: red } [data-part=item] { color: blue }",
      ),
    ).toEqual([
      ":where([data-part=item])[data-state=open] loses color vs [data-part=item]",
    ]);
  });

  it("sees a moved rule's tie with a rule inside @media", () => {
    const base = `.x { background: none }
      .x.s { background-color: blue }
      @media (any-hover: hover) { .x:hover { background: gray } }`;
    const head = `.x { background: none }
      @media (any-hover: hover) { .x:hover { background: gray } }
      .x.s { background-color: blue }`;
    const { moveFlips } = cascadeDiff(parseRules(base), parseRules(head));
    expect(
      moveFlips.map(
        (f) =>
          `${f.rule.selector} ${f.after} ${f.prop} vs ${f.other.selector} (${f.other.context})`,
      ),
    ).toEqual([
      ".x.s wins background-color~background vs .x:hover (@media (any-hover:hover))",
    ]);
  });

  it("doesn't pair mutually exclusive states", () => {
    expect(
      flips(
        "[data-state=open] { color: red } [data-state=closed] { color: blue }",
        "[data-state=closed] { color: blue } [data-state=open] { color: red }",
      ),
    ).toEqual([]);
  });
});
