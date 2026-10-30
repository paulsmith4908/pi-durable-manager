import { type CheckpointManifest } from "./checkpoint-common.js";
export interface InspectResult {
    id: string;
    dir: string;
    manifest: CheckpointManifest;
    verified: boolean;
    corrupt: string[];
}
export interface RestoreOptions {
    /** Restrict restore to these relative paths. Default: all manifest entries. */
    paths?: readonly string[];
    /** Overwrite existing files. Default false (missing files only). */
    overwrite?: boolean;
    /**
     * When set with overwrite, an existing file whose content hash differs from
     * `expectedHash[path]` is reported as a conflict (stale) and left untouched.
     */
    expectedHash?: Record<string, string>;
}
export interface RestoreResult {
    id: string;
    restored: string[];
    skipped: string[];
    conflicts: string[];
    errors: {
        path: string;
        reason: string;
    }[];
}
/** Verify a manifest and every stored preimage; never reads the workspace. */
export declare function inspectCheckpoint(privateDir: string, id: string): Promise<InspectResult>;
/**
 * Restore missing files from a checkpoint. Existing files are skipped unless
 * `overwrite: true`. Validates each stored preimage (files) or the recorded
 * target string (symlinks) before writing; never follows a symlink out of the
 * workspace; writes atomically and exclusively so a concurrent human file is
 * never clobbered. Returns honest partial results.
 */
export declare function restoreCheckpoint(root: string, privateDir: string, id: string, options?: RestoreOptions): Promise<RestoreResult>;
//# sourceMappingURL=checkpoint-restore.d.ts.map