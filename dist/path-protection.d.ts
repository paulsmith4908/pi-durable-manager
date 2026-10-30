/** Shared default protection for tools, shell, evidence and checkpoints.
 * This is a conservative filename policy, not a secret detector. Caller-owned
 * protectedPaths add project-specific exclusions without weakening defaults.
 */
export declare const PROTECTED_NAMES: readonly [".git", ".secrets", ".runtime", "config.local.json", ".aws", ".ssh", ".npmrc", ".pypirc", ".netrc", ".env", ".envrc", "credentials.json", "secrets.json", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];
export declare const SAFE_ENV_TEMPLATES: readonly [".env.example", ".env.sample", ".env.template"];
export interface ProtectedPathFilter {
    match: string;
    except?: string;
}
/** Every filter is rooted in a tree, never in a protected-looking ancestor.
 * Safe environment templates are regular filenames only. An environment-named
 * directory is protected, preventing an unsafe parent from borrowing its leaf's
 * exception (.env.private/.env.example must remain unreadable).
 * Small POSIX regexes deliberately avoid lookarounds and oversized SBPL strings.
 */
export declare function protectedPathFilters(root: string): ProtectedPathFilter[];
export declare function isProtectedRelativePath(path: string): boolean;
/** Resolve filesystem aliases while retaining a not-yet-existing suffix. */
export declare function canonicalizeProtectionPath(path: string): string;
/** Preserve both an excluded project path and its canonical target. Otherwise a
 * worker could replace a pre-existing symlink and read the newly exposed path.
 * Snapshot capture uses the same expansion so target aliases are not imaged.
 */
export declare function resolveProtectedPaths(root: string, paths: readonly string[]): string[];
//# sourceMappingURL=path-protection.d.ts.map