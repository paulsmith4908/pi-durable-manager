import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Shared default protection for tools, shell, evidence and checkpoints.
 * This is a conservative filename policy, not a secret detector. Caller-owned
 * protectedPaths add project-specific exclusions without weakening defaults.
 */
export const PROTECTED_NAMES = [
  ".git", ".secrets", ".runtime", "config.local.json", ".aws", ".ssh",
  ".npmrc", ".pypirc", ".netrc", ".env", ".envrc", "credentials.json", "secrets.json",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
] as const;
export const SAFE_ENV_TEMPLATES = [".env.example", ".env.sample", ".env.template"] as const;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const literal = (s: string): string => [...s].map(c => /[a-z]/i.test(c)
  ? `[${c.toLowerCase()}${c.toUpperCase()}]` : escape(c)).join("");
export interface ProtectedPathFilter { match: string; except?: string; }

/** Every filter is rooted in a tree, never in a protected-looking ancestor.
 * Safe environment templates are regular filenames only. An environment-named
 * directory is protected, preventing an unsafe parent from borrowing its leaf's
 * exception (.env.private/.env.example must remain unreadable).
 * Small POSIX regexes deliberately avoid lookarounds and oversized SBPL strings.
 */
export function protectedPathFilters(root: string): ProtectedPathFilter[] {
  const prefix = `^${escape(root)}/([^/]+/)*`;
  return [
    ...PROTECTED_NAMES.map(name => ({ match: prefix + literal(name) + "(/|$)" })),
    { match: prefix + literal(".env.") + "[^/]+/" },
    { match: prefix + literal(".env.") + "[^/]*$",
      except: prefix + `(${SAFE_ENV_TEMPLATES.map(literal).join("|")})$` },
    { match: prefix + "[^/]+[.]([pP][eE][mM]|[kK][eE][yY]|[pP]12|[pP][fF][xX])(/|$)" },
  ];
}
const relativeFilters = protectedPathFilters("/scope").map(f => ({ match: new RegExp(f.match), except: f.except ? new RegExp(f.except) : null }));
export function isProtectedRelativePath(path: string): boolean {
  const absolute = "/scope/" + path;
  return relativeFilters.some(f => f.match.test(absolute) && !f.except?.test(absolute));
}

/** Resolve filesystem aliases while retaining a not-yet-existing suffix. */
export function canonicalizeProtectionPath(path: string): string {
  try { return realpathSync(path); } catch { /* walk nearest existing ancestor */ }
  const lexical = resolve(path), tail: string[] = [];
  let current = lexical;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) return lexical;
    tail.unshift(current.slice(parent.length + 1)); current = parent;
    try { return resolve(realpathSync(current), ...tail); } catch { /* keep walking */ }
  }
}
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
}
/** Preserve both an excluded project path and its canonical target. Otherwise a
 * worker could replace a pre-existing symlink and read the newly exposed path.
 * Snapshot capture uses the same expansion so target aliases are not imaged.
 */
export function resolveProtectedPaths(root: string, paths: readonly string[]): string[] {
  const originalRoot = resolve(root), canonicalRoot = canonicalizeProtectionPath(root);
  return [...new Set(paths.flatMap(path => {
    const lexical = isAbsolute(path) ? resolve(path) : resolve(originalRoot, path);
    const rooted = within(originalRoot, lexical) ? resolve(canonicalRoot, relative(originalRoot, lexical)) : lexical;
    const canonical = canonicalizeProtectionPath(lexical);
    return within(canonicalRoot, rooted) ? [rooted, canonical] : [canonical];
  }))];
}
