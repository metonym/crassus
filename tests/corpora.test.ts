import { parseRules } from "crassus";
import { generate, parse, walk } from "css-tree";
import { CORPORA } from "../bench/corpora";

// Formatting-insensitive: whitespace, quote style, escapes, `::` vs `:`.
const loose = (s: string) => s.replace(/[\s"'\\]+/g, "").replace(/::/g, ":");

/** Selectors css-tree reads from style rules, keyframe steps included. */
function referenceSelectors(css: string): string[] {
  const out: string[] = [];
  walk(parse(css), {
    visit: "Rule",
    enter(node) {
      if (node.prelude.type !== "SelectorList") return;
      for (const selector of node.prelude.children)
        out.push(generate(selector));
    },
  });
  return out;
}

describe("real-world corpora", () => {
  for (const { name, css } of CORPORA) {
    it(`reads the same selectors as css-tree: ${name}`, () => {
      const ours = parseRules(css).map((r) => loose(r.selector));
      expect(ours).toEqual(referenceSelectors(css).map(loose));
    });
  }
});
