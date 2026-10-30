import { isProtectedRelativePath } from "./path-protection.js";
/**
 * Assignment evidence + checkpoint integration helpers.
 *
 * This module centralises the structural glue between the reviewed evidence
 * (`evidence.ts`) and checkpoint (`checkpoints.ts`) primitives and the
 * assignment lifecycle in `assignments.ts`. It is deliberately PURE and
 * side-effect-free where possible so the engine keeps the durable/orchestration
 * logic and this file owns only shapes, phases, bounds, and pure transforms.
 *
 * Evidence phases
 * ---------------
 *   `capturing`   — pre-admission baseline + checkpoint are being written.
 *   `admitted`    — the checkpoint completed; the worker was admitted.
 *   `blocked`     — the checkpoint could not be completed; NO provider request
 *                   was made and the writer lease is retained.
 *   `settled`     — the after-snapshot + change set were recorded.
 *
 * The persisted `AssignmentRecord.evidence` JSON is this bundle (plus the
 * legacy fields the pre-feature code wrote, kept under `legacy`).
 */

import { join } from "node:path";

/** Bumped whenever the persisted evidence bundle shape changes. */
export const EVIDENCE_VERSION = 1;

export type EvidencePhase = "capturing" | "admitted" | "blocked" | "settled";

/** Checkpoint capture bounds (documented, enforced by the capture module). */
export const DEFAULT_CHECKPOINT_MAX_FILES = 2000;
/** Per-file byte cap (10 MiB) for the pre-image checkpoint. */
export const DEFAULT_CHECKPOINT_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Total byte cap (256 MiB) for the pre-image checkpoint. */
export const DEFAULT_CHECKPOINT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
/** Inline stdout/stderr tail cap (bytes) for a persisted command summary. */
export const COMMAND_TAIL_BYTES = 4096;
/** Largest single artifact copy (4 MiB) taken from a known canonical path. */
export const MAX_ARTIFACT_COPY_BYTES = 4 * 1024 * 1024;
/** Upper bound on how many command summaries are retained per assignment. */
export const MAX_COMMAND_RECORDS = 512;
/** Compact evidence summary shown inline by `assignments.show` (bytes). */
export const SHOW_SUMMARY_MAX_BYTES = 128 * 1024;

/** Shared literal protected names; full patterns are enforced by isEvidenceProtected. */
export { PROTECTED_NAMES as EVIDENCE_PROTECTED_NAMES } from "./path-protection.js";

/** A stored command summary reference (artifact-backed full output). */
export interface CommandRecord {
  readonly seq: number;
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly stdoutTail: string | null;
  readonly stderrTail: string | null;
  readonly truncated: boolean;
  readonly totalBytes: number;
  /** Artifact id (relative to the assignment artifact dir) of the full output. */
  readonly fullOutputArtifactId: string | null;
  /** `true` when the full output exceeded the copy cap and was truncated. */
  readonly fullOutputTruncated: boolean;
}

/** Immutable reference to a written artifact. */
export interface ArtifactRef {
  readonly id: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly kind: "snapshot" | "checkpoint-manifest" | "command-output" | "restore-result" | "after-snapshot";
}

/** Bounded, phase-tagged evidence bundle persisted as `evidence` JSON. */
export interface EvidenceBundle {
  readonly version: number;
  readonly phase: EvidencePhase;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly baseline?: {
    readonly complete: boolean;
    readonly reasons: readonly string[];
    readonly fileCount: number;
    readonly capturedAt: string;
  };
  readonly checkpoint?: {
    readonly id: string;
    readonly complete: boolean;
    readonly reasons: readonly string[];
    readonly counts: { files: number; symlinks: number; totalBytes: number };
  };
  readonly commands?: readonly CommandRecord[];
  readonly after?: {
    readonly complete: boolean;
    readonly reasons: readonly string[];
    readonly capturedAt: string;
    /**
     * Immutable ref to the FULL after-manifest (every file, hash, size, mode,
     * kind) persisted as a private artifact. `bounded:true` means the manifest
     * itself was truncated at a hard bound and MUST be treated as incomplete
     * (fail closed), never accepted. Absent on legacy records, where the
     * after-manifest is unavailable and `accept` must refuse.
     */
    readonly manifest?: {
      readonly artifactId: string;
      readonly sha256: string;
      readonly bytes: number;
      readonly fileCount: number;
      readonly bounded: boolean;
      readonly reasons: readonly string[];
    };
  };
  readonly changes?: readonly {
    readonly path: string;
    readonly kind: "added" | "modified" | "deleted";
    readonly beforeHash?: string;
    readonly afterHash?: string;
    readonly size?: number;
  }[];
  /** Structured block reason when `phase === "blocked"`. */
  readonly blockedReason?: string;
  /** Legacy pre-feature evidence fields, preserved verbatim for old jobs. */
  readonly legacy?: Record<string, unknown>;
}

/** The private per-assignment directory that holds checkpoints + artifacts. */
export function assignmentEvidenceDir(stateDir: string, assignmentId: string): string {
  return join(stateDir, "checkpoints", assignmentId);
}

/** The private artifact subdirectory for one assignment's evidence. */
export function assignmentArtifactDir(stateDir: string, assignmentId: string): string {
  return join(stateDir, "artifacts", assignmentId);
}

/** True when a relative path is on the engine's protected blocklist. */
export function isEvidenceProtected(rel: string): boolean {
  return isProtectedRelativePath(rel);
}

/**
 * Parse a persisted evidence JSON blob into a bundle. Returns `null` for a
 * pre-feature (legacy) record whose shape is not a bundle, so callers can offer
 * `allowLegacy`/`unavailable` behaviour instead of silently treating it as
 * hash-verified evidence.
 */
export function parseEvidenceBundle(raw: string | null): EvidenceBundle | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.version !== "number" || typeof obj.phase !== "string") return null;
  return obj as unknown as EvidenceBundle;
}

/** Deterministic seq for a new command record under a read-modify-write. */
export function nextCommandSeq(existing: readonly CommandRecord[]): number {
  return existing.length === 0 ? 0 : existing[existing.length - 1]!.seq + 1;
}

/** Bounded, de-duplicated command list (drops the oldest beyond the cap). */
export function boundCommands(cmds: readonly CommandRecord[]): CommandRecord[] {
  if (cmds.length <= MAX_COMMAND_RECORDS) return [...cmds];
  return cmds.slice(cmds.length - MAX_COMMAND_RECORDS);
}

/**
 * A null-prototype dictionary keyed by git-emitted relative path. Using
 * `Object.create(null)` makes a file literally named `__proto__` (and
 * `constructor`, `hasOwnProperty`, …) a plain own entry instead of mutating the
 * prototype or being silently dropped — a real POSIX filename the tree walk
 * must not lose.
 */
export function pathDictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** True when `abs` is a strict descendant of `root` (lexical, no traversal). */
export function isWithinLexical(root: string, abs: string): boolean {
  if (abs === root) return false;
  const withSep = root.endsWith("/") ? root : `${root}/`;
  return abs.startsWith(withSep);
}
