// integration/checkpoints.ts — public surface for pre-assignment checkpoints.
export { createCheckpoint } from "./checkpoint-capture.js";
export { inspectCheckpoint, restoreCheckpoint } from "./checkpoint-restore.js";
export type {
  CheckpointEntry,
  CheckpointCounts,
  CheckpointManifest,
  CheckpointRef,
  CheckpointLimits,
  CheckpointOptions,
} from "./checkpoint-common.js";
export type {
  InspectResult,
  RestoreOptions,
  RestoreResult,
} from "./checkpoint-restore.js";
