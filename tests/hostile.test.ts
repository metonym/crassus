import { cascadeDiff, deadDeclarations, parseRules } from "crassus";
import { HOSTILE } from "./hostile-inputs";

// Each must parse without throwing, quickly.
describe("hostile inputs", () => {
  for (const [name, css] of Object.entries(HOSTILE)) {
    it(name, () => {
      const t0 = performance.now();
      const rules = parseRules(css, true);
      deadDeclarations(css, true);
      cascadeDiff(rules, rules);
      expect(performance.now() - t0).toBeLessThan(5000);
    });
  }
});
