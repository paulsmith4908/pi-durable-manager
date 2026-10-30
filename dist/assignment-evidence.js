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
/** The private per-assignment directory that holds checkpoints + artifacts. */
export function assignmentEvidenceDir(stateDir, assignmentId) {
    return join(stateDir, "checkpoints", assignmentId);
}
/** The private artifact subdirectory for one assignment's evidence. */
export function assignmentArtifactDir(stateDir, assignmentId) {
    return join(stateDir, "artifacts", assignmentId);
}
/** True when a relative path is on the engine's protected blocklist. */
export function isEvidenceProtected(rel) {
    return isProtectedRelativePath(rel);
}
/**
 * Parse a persisted evidence JSON blob into a bundle. Returns `null` for a
 * pre-feature (legacy) record whose shape is not a bundle, so callers can offer
 * `allowLegacy`/`unavailable` behaviour instead of silently treating it as
 * hash-verified evidence.
 */
export function parseEvidenceBundle(raw) {
    if (raw === null)
        return null;
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (value === null || typeof value !== "object")
        return null;
    const obj = value;
    if (typeof obj.version !== "number" || typeof obj.phase !== "string")
        return null;
    return obj;
}
/** Deterministic seq for a new command record under a read-modify-write. */
export function nextCommandSeq(existing) {
    return existing.length === 0 ? 0 : existing[existing.length - 1].seq + 1;
}
/** Bounded, de-duplicated command list (drops the oldest beyond the cap). */
export function boundCommands(cmds) {
    if (cmds.length <= MAX_COMMAND_RECORDS)
        return [...cmds];
    return cmds.slice(cmds.length - MAX_COMMAND_RECORDS);
}
/**
 * A null-prototype dictionary keyed by git-emitted relative path. Using
 * `Object.create(null)` makes a file literally named `__proto__` (and
 * `constructor`, `hasOwnProperty`, …) a plain own entry instead of mutating the
 * prototype or being silently dropped — a real POSIX filename the tree walk
 * must not lose.
 */
export function pathDictionary() {
    return Object.create(null);
}
/** True when `abs` is a strict descendant of `root` (lexical, no traversal). */
export function isWithinLexical(root, abs) {
    if (abs === root)
        return false;
    const withSep = root.endsWith("/") ? root : `${root}/`;
    return abs.startsWith(withSep);
}
//# sourceMappingURL=assignment-evidence.js.map