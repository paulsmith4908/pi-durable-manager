// integration/checkpoint-restore.ts — inspectCheckpoint / restoreCheckpoint.
// Inspect verifies stored preimages without reading the workspace. Restore
// writes MISSING files only; existing files are skipped unless overwrite:true,
// and an optional expectedHash guards against clobbering a changed file.

import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, symlink, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  ancestorsSafe,
  checkpointDir,
  FILES_DIR,
  hashPath,
  hashTarget,
  isWithin,
  MANIFEST_NAME,
  MAX_MANIFEST_BYTES,
  OPEN_EXCL,
  parseManifest,
  resolvePrivateRoot,
  safeRelPath,
  type CheckpointManifest,
} from "./checkpoint-common.js";

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
  errors: { path: string; reason: string }[];
}

/** Read a stored preimage as a regular file (O_NOFOLLOW), enforcing size. */
async function readRegularExclusive(path: string, expectedSize: number): Promise<Buffer | null> {
  const st = await lstat(path).catch(() => undefined);
  if (st === undefined || !st.isFile() || st.isSymbolicLink() || st.size !== expectedSize) return null;
  const fh = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => undefined);
  if (!fh) return null;
  try {
    const buf = await fh.readFile();
    return buf.length === expectedSize ? buf : null;
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/**
 * Write validated `content` to `target`. For a missing target uses an exclusive
 * (O_EXCL | O_NOFOLLOW) create so a concurrent human file is never clobbered.
 * For an explicit overwrite, writes to an exclusive sibling temp and atomically
 * renames over the target — the original is untouched until the rename succeeds.
 */
async function writeFileAtomic(
  target: string,
  content: Buffer,
  mode: number,
  replacing: boolean,
): Promise<void> {
  if (!replacing) {
    const fh = await open(target, OPEN_EXCL | fsConstants.O_NOFOLLOW, mode).catch((error) => {
      throw new Error(`refusing to clobber existing file (${(error as NodeJS.ErrnoException).code})`);
    });
    try {
      await fh.writeFile(content);
    } finally {
      await fh.close().catch(() => undefined);
    }
    await chmod(target, mode).catch(() => undefined);
    return;
  }
  const tmp = `${target}.ckpt-tmp-${process.pid}-${Date.now()}`;
  const fh = await open(tmp, OPEN_EXCL | fsConstants.O_NOFOLLOW, mode);
  let ok = false;
  try {
    await fh.writeFile(content);
    await fh.close();
    await chmod(tmp, mode).catch(() => undefined);
    await rename(tmp, target);
    ok = true;
  } finally {
    if (!ok) {
      await fh.close().catch(() => undefined);
      await unlink(tmp).catch(() => undefined);
    }
  }
}

/** Recreate a symlink with the exact recorded target string (no dereference). */
async function writeSymlinkSafely(target: string, linkTarget: string, replacing: boolean): Promise<void> {
  if (replacing) await unlink(target);
  await symlink(linkTarget, target);
}

/**
 * Read + structurally validate the manifest. Enforces a regular-file,
 * O_NOFOLLOW read (no symlink swap) under a 4 MiB byte cap, then delegates
 * structural validation to parseManifest (version/id/root/kind/hash/size/mode/
 * relative-path, ≤2000 entries, protected-path rejection).
 */
async function readManifest(
  dir: string,
  expected: { id?: string; root?: string } = {},
): Promise<CheckpointManifest> {
  const path = join(dir, MANIFEST_NAME);
  const st = await lstat(path).catch(() => undefined);
  if (st === undefined) throw new Error(`invalid checkpoint manifest: missing ${MANIFEST_NAME}`);
  if (!st.isFile() || st.isSymbolicLink()) {
    throw new Error("invalid checkpoint manifest: not a regular file");
  }
  if (st.size > MAX_MANIFEST_BYTES) throw new Error("invalid checkpoint manifest: exceeds 4 MiB");
  const sh = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const text = await sh.readFile("utf8");
    return parseManifest(text, expected);
  } finally {
    await sh.close().catch(() => undefined);
  }
}

/** Verify a manifest and every stored preimage; never reads the workspace. */
export async function inspectCheckpoint(privateDir: string, id: string): Promise<InspectResult> {
  const realPrivate = await resolvePrivateRoot(privateDir);
  const dir = checkpointDir(realPrivate, id);
  // Validated at read time: structure, id, root canonical form, bounds, paths.
  const manifest = await readManifest(dir, { id });
  const corrupt: string[] = [];
  for (const entry of manifest.files) {
    let osRel: string;
    try {
      osRel = safeRelPath(entry.path);
    } catch (error) {
      corrupt.push(`${entry.path}: ${(error as Error).message}`);
      continue;
    }
    if (entry.kind === "symlink") {
      // No preimage exists for symlinks: validate the recorded target string.
      if (typeof entry.target !== "string" || hashTarget(entry.target) !== entry.sha256) {
        corrupt.push(`${entry.path}: symlink target hash mismatch`);
      }
      continue;
    }
    const stored = join(dir, FILES_DIR, osRel);
    if (!isWithin(join(dir, FILES_DIR), stored)) {
      corrupt.push(`${entry.path}: stored path escapes files dir`);
      continue;
    }
    const actual = await hashPath(stored, entry.kind);
    if (actual === null) {
      corrupt.push(`${entry.path}: preimage missing`);
    } else if (actual !== entry.sha256) {
      corrupt.push(`${entry.path}: preimage hash mismatch`);
    }
  }
  return { id, dir, manifest, verified: corrupt.length === 0, corrupt };
}

/**
 * Restore missing files from a checkpoint. Existing files are skipped unless
 * `overwrite: true`. Validates each stored preimage (files) or the recorded
 * target string (symlinks) before writing; never follows a symlink out of the
 * workspace; writes atomically and exclusively so a concurrent human file is
 * never clobbered. Returns honest partial results.
 */
export async function restoreCheckpoint(
  root: string,
  privateDir: string,
  id: string,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  const realRoot = await resolvePrivateRoot(root);
  const realPrivate = await resolvePrivateRoot(privateDir);
  const dir = checkpointDir(realPrivate, id);
  // Validate structure AND that the manifest's canonical root is this tree.
  const manifest = await readManifest(dir, { id, root: realRoot });
  const overwrite = options.overwrite === true;
  const filter = options.paths === undefined ? undefined : new Set(options.paths);
  const filesDir = join(dir, FILES_DIR);

  const restored: string[] = [];
  const skipped: string[] = [];
  const conflicts: string[] = [];
  const errors: { path: string; reason: string }[] = [];

  for (const entry of manifest.files) {
    if (filter !== undefined && !filter.has(entry.path)) continue;
    let osRel: string;
    try {
      osRel = safeRelPath(entry.path);
    } catch (error) {
      errors.push({ path: entry.path, reason: (error as Error).message });
      continue;
    }
    const target = join(realRoot, osRel);
    if (!isWithin(realRoot, target)) {
      errors.push({ path: entry.path, reason: "path escapes root" });
      continue;
    }

    // Validate the entry's own data before touching the tree.
    let content: Buffer | null = null;
    if (entry.kind === "file") {
      const stored = join(filesDir, osRel);
      if (!isWithin(filesDir, stored)) {
        errors.push({ path: entry.path, reason: "stored path escapes files dir" });
        continue;
      }
      // Guards: preimage parents must not escape via symlink (private root is
      // trusted, but this rejects a tampered/hostile layout).
      if ((await ancestorsSafe(filesDir, entry.path, true)) === false) {
        errors.push({ path: entry.path, reason: "unsafe preimage ancestor" });
        continue;
      }
      const storedHash = await hashPath(stored, "file");
      if (storedHash === null || storedHash !== entry.sha256) {
        errors.push({ path: entry.path, reason: "checkpoint preimage corrupt" });
        continue;
      }
      content = await readRegularExclusive(stored, entry.size);
      if (content === null) {
        errors.push({ path: entry.path, reason: "checkpoint preimage corrupt" });
        continue;
      }
    } else if (hashTarget(entry.target ?? "") !== entry.sha256) {
      // Symlink: validated at manifest parse, but re-assert defensively.
      errors.push({ path: entry.path, reason: "checkpoint symlink target mismatch" });
      continue;
    }

    const present = await lstat(target).catch(() => undefined);
    if (present !== undefined && !overwrite) {
      skipped.push(entry.path);
      continue;
    }
    if (present !== undefined) {
      const expected = options.expectedHash?.[entry.path];
      if (expected !== undefined) {
        const currentHash = await hashPath(target, entry.kind);
        if (currentHash !== expected) {
          conflicts.push(entry.path);
          continue;
        }
      }
    }

    // Reject a symlinked ancestor that would redirect the write outside root.
    if ((await ancestorsSafe(realRoot, entry.path, true)) === false) {
      errors.push({ path: entry.path, reason: "unsafe ancestor" });
      continue;
    }

    try {
      await mkdir(dirname(target), { recursive: true });
      if (entry.kind === "symlink") {
        await writeSymlinkSafely(target, entry.target ?? "", present !== undefined);
      } else {
        await writeFileAtomic(target, content as Buffer, entry.mode, present !== undefined);
      }
      restored.push(entry.path);
    } catch (error) {
      errors.push({ path: entry.path, reason: (error as Error).message });
    }
  }
  return { id, restored, skipped, conflicts, errors };
}
