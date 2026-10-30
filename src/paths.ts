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

import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

/**
 * Known macOS system aliases: canonical targets for the symlinks Apple ships
 * (`/tmp`, `/var`, `/etc`). A symlink resolving to one of these is not a
 * user-supplied indirection and must not be treated as unsafe.
 */
const SYSTEM_ALIAS_TARGETS = new Set<string>([
  "/private/tmp",
  "/private/var",
  "/private/etc",
]);

/** True when `p` exists and its final component is a symlink. */
export function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * True when `p` exists. Uses `lstat` so a *dangling* symlink still counts as
 * present (we want to reject writing "through" it rather than silently creating
 * a new file at the target).
 */
export function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Canonicalize a path. Resolves the whole chain with `realpath` when possible
 * (so macOS `/tmp`→`/private/tmp` becomes canonical), otherwise resolves the
 * longest existing prefix and appends the remaining components verbatim.
 */
export function canonicalPath(p: string): string {
  const abs = isAbsolute(p) ? p : resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    // Fall back: walk up to the nearest existing ancestor and canonicalize that.
    const parts: string[] = [];
    let cur = abs;
    for (;;) {
      try {
        const real = realpathSync(cur);
        return parts.length === 0 ? real : join(real, ...parts.reverse());
      } catch {
        const parent = dirname(cur);
        if (parent === cur) return abs;
        parts.push(cur.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
        cur = parent;
      }
    }
  }
}

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
export function firstUserSymlinkAncestor(p: string, stopAt?: string): string | undefined {
  const abs = isAbsolute(p) ? p : resolve(p);
  const stop = stopAt !== undefined ? (isAbsolute(stopAt) ? stopAt : resolve(stopAt)) : undefined;
  // Collect components from root to leaf.
  const comps: string[] = [];
  let cur = abs;
  for (;;) {
    const parent = dirname(cur);
    comps.push(cur);
    if (parent === cur) break;
    cur = parent;
  }
  comps.reverse();
  for (const candidate of comps) {
    if (stop !== undefined && (candidate === stop || !candidate.startsWith(stop.endsWith(sep) ? stop : stop + sep))) {
      // At or above the stop boundary: skip (but keep scanning deeper).
      if (candidate === stop) continue;
      if (!candidate.startsWith(stop.endsWith(sep) ? stop : stop + sep)) continue;
    }
    let lst;
    try {
      lst = lstatSync(candidate);
    } catch {
      continue; // doesn't exist yet — not a symlink
    }
    if (!lst.isSymbolicLink()) continue;
    let target: string;
    try {
      target = realpathSync(candidate);
    } catch {
      // Dangling symlink: definitely a user symlink we must not write through.
      return candidate;
    }
    if (SYSTEM_ALIAS_TARGETS.has(target)) continue;
    // A system-alias *prefix* (e.g. /private/var/folders/...) is also fine.
    if ([...SYSTEM_ALIAS_TARGETS].some((t) => target === t || target.startsWith(t + sep))) continue;
    return candidate;
  }
  return undefined;
}

/** True when `child` is `parent` or lives strictly under it (boundary-safe). */
export function isWithin(parent: string, child: string): boolean {
  if (parent === child) return true;
  const p = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(p);
}
