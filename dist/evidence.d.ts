/** Hard cap on the number of files captured; caller values are clamped to it. */
export declare const HARD_MAX_FILES = 2000;
/** Hard cap on per-file bytes hashed/copied; caller values are clamped to it. */
export declare const HARD_MAX_FILE_BYTES: number;
/** Defaults derive from the hard caps. */
export declare const DEFAULT_MAX_FILES = 2000;
export declare const DEFAULT_MAX_FILE_BYTES: number;
/** Credential/state files that must never be hashed or copied. */
export declare const PROTECTED_FILES: readonly string[];
/** Directory names (anywhere in the tree) that are never read. */
export declare const PROTECTED_NAMES: readonly string[];
export interface SnapshotFileEntry {
    sha256: string;
    size: number;
    mode: number;
    kind: "file" | "symlink";
}
export interface Snapshot {
    root: string;
    capturedAt: string;
    files: Record<string, SnapshotFileEntry>;
    complete: boolean;
    reasons: string[];
}
export interface CaptureOptions {
    protectedPaths?: readonly string[];
    sanitize?: (s: string) => string;
    maxFiles?: number;
    maxFileBytes?: number;
}
/**
 * Capture a bounded, hashed snapshot of the working tree at `root`.
 *
 * Enumerates via git (tracked + untracked-not-ignored, unborn-repo safe), skips
 * protected paths, hashes regular files and symlink targets (never secret
 * contents, never follows an ancestor or leaf symlink out of the checkout), and
 * sets `complete:false` with explicit reasons for any read failure or bound.
 *
 * A tracked path that is simply missing (a normal `git rm`/`unlink` deletion) is
 * excluded WITHOUT marking the snapshot incomplete, so compare-before/after can
 * report it as `deleted`. Other read errors stay incomplete.
 */
export declare function captureSnapshot(root: string, options?: CaptureOptions): Promise<Snapshot>;
export interface CompareEntry {
    path: string;
    kind: "added" | "modified" | "deleted";
    beforeHash?: string;
    afterHash?: string;
    size?: number;
}
/**
 * Diff two snapshots. A file present and byte/mode-identical in `before` and
 * `after` is never reported. A file that was already present in `before` and
 * is unchanged is *not* "changed" even if it is untracked — we compare content,
 * not git status.
 */
export declare function compareSnapshots(before: Snapshot, after: Snapshot): {
    changedFiles: CompareEntry[];
};
export interface VerifyResult {
    ok: boolean;
    staleFiles: string[];
    missingFiles: string[];
    /** Files present now that were absent from the snapshot (additions). */
    extraFiles: string[];
    reasons: string[];
}
/**
 * Confirm that the current tree still matches `snapshot`: every recorded file
 * must re-hash to the same digest (and mode), and deletions are detected. A
 * file that legitimately lives outside the snapshot (protected/new) is ignored;
 * a recorded file that changed or vanished is reported as stale.
 */
export declare function verifySnapshot(root: string, snapshot: Snapshot, options?: CaptureOptions): Promise<VerifyResult>;
/** Deterministic JSON with sorted object keys, so the hash is stable. */
export declare function stableStringify(value: unknown): string;
export interface WriteArtifactResult {
    path: string;
    sha256: string;
    bytes: number;
}
export interface WriteArtifactOptions {
    /**
     * Applied to the serialized UTF-8 text of the artifact for JSON values and
     * strings (recursively, since the whole serialized string is scrubbed). The
     * redacted bytes are what get hashed and written. If omitted, the caller MUST
     * have already sanitized `data` — this module does not know your secret
     * patterns and will NOT silently redact raw secrets.
     */
    sanitize?: (s: string) => string;
    maxBytes?: number;
}
/**
 * Write `data` (a JSON-serializable value, or raw string/Uint8Array bytes) to a
 * new immutable file `join(privateEvidenceDir, id)` with mode 0600 under a 0700
 * directory. Refuses to overwrite, refuses a symlink/non-regular target, and
 * rejects ids that could traverse. Only ever writes inside the caller-owned dir.
 *
 * Redaction is explicit: pass `sanitize` to scrub the serialized UTF-8 text
 * (applied to the whole JSON/string, so nested secret fields are covered), or
 * sanitize `data` yourself. There is no implicit redaction.
 */
export declare function writeArtifact(privateEvidenceDir: string, id: string, data: unknown, options?: WriteArtifactOptions): Promise<WriteArtifactResult>;
export interface CommandResultInput {
    command?: string;
    argv?: readonly string[];
    exitCode?: number | null;
    signal?: string | null;
    timedOut?: boolean;
    durationMs?: number;
    stdout?: string | Uint8Array;
    stderr?: string | Uint8Array;
}
export interface CommandResultSummary {
    command: string;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    durationMs: number;
    totalBytes: number;
    truncated: boolean;
    stdoutTail: string;
    stderrTail: string;
    fullOutputPath: null;
    ok: boolean;
}
export interface SanitizeCommandOptions {
    sanitize?: (s: string) => string;
    maxInlineBytes?: number;
}
/**
 * Produce a bounded, public-safe summary of a command result. Exact command
 * text is only redacted when the caller supplies `sanitize`; full output is
 * never inlined (the caller persists it separately via writeArtifact). A
 * nonzero exit code is never masked.
 */
export declare function sanitizeCommandResult(result: CommandResultInput, options?: SanitizeCommandOptions): CommandResultSummary;
//# sourceMappingURL=evidence.d.ts.map