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

  it("doesn't pair mutually exclusive states", () => {
    expect(
      flips(
        "[data-state=open] { color: red } [data-state=closed] { color: blue }",
        "[data-state=closed] { color: blue } [data-state=open] { color: red }",
      ),
    ).toEqual([]);
  });
});
