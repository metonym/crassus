// Runtime-neutral: no Bun, Node or DOM APIs, so it runs anywhere JS does.

export { parseRules, type Rule } from "./core/cascade";
export {
  type BrowserConfig,
  type Config,
  defineConfig,
  type Stylesheets,
} from "./core/config";
export { type CascadeDiff, cascadeDiff, type Flip } from "./core/diff";
export { type DeadDeclaration, deadDeclarations } from "./core/overrides";
export { canonicalContext } from "./core/placement";
export { canonicalSelector } from "./core/selector";
export { SHORTHANDS } from "./core/shorthands";
