/**
 * Canonical path helpers shared by setup, check and the installers.
 *
 * The subtlety this module exists for: on macOS `/tmp` and `/var` are themselves
 * symlinks into `/private` (`/tmp -> /private/tmp`, `/var -> /private/var`).
 * A naive "reject any symlink" rule would wrongly reject every path under the
 * system temp dir. We therefore:
 *
 *   * Canonicalize using the OS (`realpath`) when the path exists, which
 *     resolves the `/tmp`→`/private/tmp` system aliases transparently.
 *   * Only flag a USER-CREATED symlink (one whose own final component, or an
 *     ancestor, is a symlink NOT part of the known macOS system alias set).
 *
 * Nothing here reads file contents; it only resolves names.
 */
/** True when `p` exists and its final component is a symlink. */
export declare function isSymlink(p: string): boolean;
/**
 * True when `p` exists. Uses `lstat` so a *dangling* symlink still counts as
 * present (we want to reject writing "through" it rather than silently creating
 * a new file at the target).
 */
export declare function lexists(p: string): boolean;
/**
 * Canonicalize a path. Resolves the whole chain with `realpath` when possible
 * (so macOS `/tmp`→`/private/tmp` becomes canonical), otherwise resolves the
 * longest existing prefix and appends the remaining components verbatim.
 */
export declare function canonicalPath(p: string): string;
/**
 * Return the first ancestor (from the root down) of `p` that is a USER symlink
 * (a symlink whose target is not a known macOS system alias), or `undefined`
 * when the path is clean. The final component is included: a symlinked file is
 * itself a user symlink.
 *
 * `stopAt` (typically the home dir or a project root) is NOT inspected as an
 * ancestor — only components strictly *below* it — so a user's symlinked home
 * on a shared volume is not misreported.
 */
export declare function firstUserSymlinkAncestor(p: string, stopAt?: string): string | undefined;
/** True when `child` is `parent` or lives strictly under it (boundary-safe). */
export declare function isWithin(parent: string, child: string): boolean;
//# sourceMappingURL=paths.d.ts.map