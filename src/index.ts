/**
 * crassus core: runtime-neutral cascade analysis. No Bun, Node or DOM APIs;
 * runs in Bun, Node, Deno, browsers and workers.
 */

export { parseRules, type Rule } from "./core/cascade";
export { type Config, defineConfig, type Stylesheets } from "./core/config";
export { type CascadeDiff, cascadeDiff, type Flip } from "./core/diff";
export { type DeadDeclaration, deadDeclarations } from "./core/overrides";
