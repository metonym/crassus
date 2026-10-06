import {
  alignRules,
  cascadeOrder,
  engineDeclarations,
  libraryRules,
} from "../src/core/align";
import { replayWins } from "../src/core/usage";

const SHEET = `
.a { color: red; padding: 0 }
@media print { .a { color: blue } }
@keyframes k { to { top: 0 } }
@layer base { #x.a { color: green } }
@scope (.r) { .a { color: gray } }
.a.b, .c { color: black; zoom: nope }
`;

describe("libraryRules / alignRules", () => {
  it("lists style rules in CSSOM order, keyframes left out", () => {
    const rules = libraryRules(SHEET);
    expect(
      rules.map((r) => [r.context, r.layerRank !== undefined, r.scoped]),
    ).toEqual([
      ["", false, false],
      ["@media print", false, false],
      ["", true, false],
      ["", false, true],
      ["", false, false],
    ]);
    expect(rules[4].selectors.map((s) => [s.canon, s.spec])).toEqual([
      [".a.b", [0, 2, 0]],
      [".c", [0, 1, 0]],
    ]);
  });

  it("aligns by selector text, skipping rules the engine dropped", () => {
    const parsed = libraryRules(SHEET);
    // The engine serializes differently and dropped the @media rule; it
    // also lists a rule the sheet doesn't have.
    const aligned = alignRules(
      [".a", "#x.a", ".unknown", ".a", ".a.b, .c"],
      parsed,
    );
    expect(aligned).toEqual([
      parsed[0],
      parsed[2],
      undefined,
      parsed[3],
      parsed[4],
    ]);
  });
});

describe("engineDeclarations", () => {
  it("asks about each pair once, then drops invalid values and expands longhands", () => {
    const aligned = libraryRules(SHEET);
    const { pairs, resolve } = engineDeclarations(aligned);
    expect(pairs).toContainEqual(["zoom", "nope"]);
    expect(pairs.filter(([p, v]) => p === "color" && v === "red").length).toBe(
      1,
    );
    const valid = pairs.map(([p]) => p !== "zoom");
    const declarations = resolve({
      longhands: { padding: ["padding-top", "padding-right"] },
      valid,
    });
    expect(declarations(aligned[0])).toEqual([
      {
        property: "color",
        value: "red",
        important: false,
        longhands: ["color"],
      },
      {
        property: "padding",
        value: "0",
        important: false,
        longhands: ["padding-top", "padding-right"],
      },
    ]);
    expect(declarations(aligned[4]).map((d) => d.property)).toEqual(["color"]);
  });
});

describe("cascadeOrder", () => {
  const aligned = libraryRules(SHEET);
  const { pairs, resolve } = engineDeclarations(aligned);
  const declarations = resolve({ longhands: {}, valid: pairs.map(() => true) });
  const order = (matches: number[][]) =>
    cascadeOrder(matches, aligned, declarations).map((r) => r.selector);

  it("orders by layer, specificity, scope, then source order", () => {
    // `#x.a` is heavier but layered, so it comes first; the scoped `.a`
    // beats the unscoped one at equal specificity.
    expect(
      order([
        [3, 0],
        [0, 0],
        [2, 0],
      ]),
    ).toEqual(["#x.a", ".a", ".a"]);
    const [, unscoped, scoped] = cascadeOrder(
      [
        [3, 0],
        [0, 0],
        [2, 0],
      ],
      aligned,
      declarations,
    );
    expect(unscoped.declarations[0].value).toBe("red");
    expect(scoped.declarations[0].value).toBe("gray");
  });

  it("uses the heaviest matching selector, and the first one as the label", () => {
    const [rule] = cascadeOrder([[4, 1, 0]], aligned, declarations);
    expect(rule.selector).toBe(".c");
    expect(
      order([
        [4, 1],
        [0, 0],
      ]),
    ).toEqual([".a", ".c"]);
    expect(
      order([
        [4, 0],
        [0, 0],
      ]),
    ).toEqual([".a", ".a.b"]);
  });

  it("skips unaligned rules and feeds replay", () => {
    const rules = cascadeOrder(
      [
        [0, 0],
        [99, 0],
        [4, 0],
      ],
      aligned,
      declarations,
    );
    expect(rules.length).toBe(2);
    // `.a.b` wins color over `.a`; `.a`'s padding still wins.
    expect(replayWins(rules)).toEqual([
      [false, true],
      [true, true],
    ]);
  });
});
