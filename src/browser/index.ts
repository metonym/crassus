// Bun-only, experimental: real-browser checks on Bun.WebView (Chrome via CDP,
// or the system WebKit on macOS).

export type {
  ChangeGroup,
  PageDiff,
  PropertyChange,
  Snapshot,
  Uncompared,
} from "../core/snapshot-diff";
export { type CompareOptions, compareCss } from "./compare";
export { type ServeOptions, serveFixtures } from "./serve";
export { type CaptureOptions, capture, readSnapshot } from "./snapshot";
export {
  diffSnapshots,
  IncompleteCaptureError,
  type SnapshotDiff,
  type SnapshotDiffOptions,
  type SnapshotPageDiff,
} from "./snapshot-diff";
export { runUsage, type UsageFile, type UsageOptions } from "./usage";
export type { Viewport } from "./view";
