// Bun-only, experimental: real-browser checks on Bun.WebView (Chrome via CDP,
// or the system WebKit on macOS).

export type {
  ChangeGroup,
  PageDiff,
  PropertyChange,
  Snapshot,
} from "../core/snapshot-diff";
export { serveFixtures } from "./serve";
export { type CaptureOptions, capture } from "./snapshot";
export {
  diffSnapshots,
  type SnapshotDiff,
  type SnapshotDiffOptions,
  type SnapshotPageDiff,
} from "./snapshot-diff";
export { runUsage, type UsageFile, type UsageOptions } from "./usage";
export type { Viewport } from "./view";
