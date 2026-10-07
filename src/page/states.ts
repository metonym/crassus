export const STATE_SETS: Record<string, string[]> = {
  hover: ["hover"],
  focus: ["focus", "focus-visible"],
  active: ["active"],
};

/** State pseudo-classes, rewritten to `[data-cr-*]` when forced without CDP. */
export const STATE_RE =
  /:(focus-visible|focus-within|hover|focus|active)(?![\w-])/g;

/** Elements whose states are forced, up to MAX_STATE_ELEMENTS per page. */
export const INTERACTIVE =
  "a, button, input, select, textarea, [tabindex], [role], label, li, tr, td, th, summary";
export const MAX_STATE_ELEMENTS = 80;
/** Descendants of a forced element observed in that state. */
export const MAX_STATE_DESCENDANTS = 30;
