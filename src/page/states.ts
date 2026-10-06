// Forced states, shared by the snapshot, both usage engines and the page script.

/** What each forced state sets. Focus also sets `:focus-visible`. */
export const STATE_SETS: Record<string, string[]> = {
  hover: ["hover"],
  focus: ["focus", "focus-visible"],
  active: ["active"],
};

/** Elements whose states are forced, up to MAX_STATE_ELEMENTS per page. */
export const INTERACTIVE =
  "a, button, input, select, textarea, [tabindex], [role], label, li, tr, td, th, summary";
export const MAX_STATE_ELEMENTS = 80;
/** Descendants of a forced element observed in that state. */
export const MAX_STATE_DESCENDANTS = 30;
