/** Strict, traversal-free checkpoint id: 1..128 safe chars. */
export declare const CHECKPOINT_ID_RE: RegExp;
export declare const MANIFEST_NAME = "manifest.json";
export declare const FILES_DIR = "files";
/** Write a fresh file exclusively; refuses to clobber an existing checkpoint. */
export declare const OPEN_EXCL: number;
export interface CheckpointEntry {
    /** git-emitted relative path (POSIX `/` separators). */
    path: string;
    kind: "file" | "symlink";
    /** sha256 of stored bytes (file) or of the target string (symlink). */
    sha256: string;
    size: number;
    mode: number;
    /** Symlinks: target string only; never dereferenced. */
    target?: string;
}
export interface CheckpointCounts {
    files: number;
    symlinks: number;
    totalBytes: number;
}
export interface CheckpointManifest {
    version?: number;
    id: string;
    root: string;
    createdAt: string;
    files: CheckpointEntry[];
    counts: CheckpointCounts;
    complete: boolean;
    reasons: string[];
}
export interface CheckpointRef {
    id: string;
    dir: string;
    manifest: CheckpointManifest;
    counts: CheckpointCounts;
    complete: boolean;
    reasons: string[];
}
export interface CheckpointLimits {
    maxFiles?: number;
    maxFileBytes?: number;
    maxTotalBytes?: number;
}
/** Capture options: bounds plus evidence-style protected paths / sanitizer. */
export interface CheckpointOptions extends CheckpointLimits {
    protectedPaths?: readonly string[];
    sanitize?: (text: string) => string;
}
/** Lexically resolved containment: is `p` inside directory `parent`? */
export declare function isWithin(parent: string, p: string): boolean;
export declare function validId(id: unknown): boolean;
/** Validate a git relative path: non-empty, relative, no `..`/NUL. OS-joined. */
export declare function safeRelPath(rel: string): string;
/** Resolve the checkpoint directory for `id` under `privateDir`, validating. */
export declare function checkpointDir(privateDir: string, id: string): string;
/** Canonicalize the private root; ensure it is a real dir (no symlink escape). */
export declare function resolvePrivateRoot(privateDir: string): Promise<string>;
export declare function countEntries(files: readonly CheckpointEntry[]): CheckpointCounts;
/** Validate a bound is a positive finite integer; clamp to the hard cap. */
export declare function clampBound(name: string, v: number | undefined, hard: number): number;
/** Walk parents of POSIX-relative `rel`; reject symlinked/non-dir ancestors. */
export declare function ancestorsSafe(realRoot: string, rel: string, allowMissing?: boolean): Promise<boolean>;
/** sha256 of a file's bytes (via O_NOFOLLOW) or of a symlink's target string. */
export declare function hashPath(path: string, kind: "file" | "symlink"): Promise<string | null>;
/** Write bytes exclusively (0600, O_EXCL); refuses to clobber an existing file. */
export declare function writeExclusive(path: string, data: Buffer | string): Promise<void>;
/** sha256 of a symlink target string, matching capture-time hashing. */
export declare function hashTarget(target: string): string;
/** Hard bound on manifest size and entry count accepted on read. */
export declare const MAX_MANIFEST_BYTES: number;
export declare const MAX_MANIFEST_FILES = 2000;
/**
 * Credential/config path segments that must never appear in a manifest entry,
 * even if the manifest was tampered with. Matched on exact component or file
 * name, using the same default policy as tools and shell execution.
 */
export declare function isProtectedRelPath(rel: string): boolean;
/**
 * Parse and structurally validate manifest JSON. `expectedRoot` (canonical) and
 * `expectedId`, when supplied, must match — preventing a checkpoint from a
 * different project or id being applied to the wrong tree.
 */
export declare function parseManifest(raw: string, expected?: {
    id?: string;
    root?: string;
}): CheckpointManifest;
//# sourceMappingURL=checkpoint-common.d.ts.map