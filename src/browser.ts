// Bun-only, experimental: real-browser checks on Bun.WebView (Chrome via
// CDP, or the system WebKit on macOS).

export type {
  Card,
  CardChange,
  CardElement,
  Cause,
  Fix,
  Report,
  Verdict,
} from "./core/cards";
export type {
  ChangeGroup,
  DeltaE,
  Explained,
  PageDiff,
  PropertyChange,
  Snapshot,
  TokenChange,
  Uncompared,
  Winner,
} from "./core/snapshot-diff";
export {
  type CompareOptions,
  compareCss,
  type Impact,
} from "./browser/compare";
export { type ServeOptions, serveFixtures } from "./browser/serve";
export { type CaptureOptions, capture, readSnapshot } from "./browser/snapshot";
export {
  diffSnapshots,
  IncompleteCaptureError,
  type SnapshotDiff,
  type SnapshotDiffOptions,
  type SnapshotPageDiff,
} from "./browser/snapshot-diff";
export { runUsage, type UsageFile, type UsageOptions } from "./browser/usage";
export type { Viewport } from "./browser/view";
