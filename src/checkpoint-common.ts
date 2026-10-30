import { isProtectedRelativePath } from "./path-protection.js";
// integration/checkpoint-common.ts — shared types, layout, path/id safety.
// Layout: <privateDir>/<id>/{manifest.json, files/<rel>} (0700 dir, 0600 files).

import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Strict, traversal-free checkpoint id: 1..128 safe chars. */
export const CHECKPOINT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const MANIFEST_NAME = "manifest.json";
export const FILES_DIR = "files";
/** Write a fresh file exclusively; refuses to clobber an existing checkpoint. */
export const OPEN_EXCL = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;

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
export function isWithin(parent: string, p: string): boolean {
  const rel = relative(resolve(parent), resolve(p));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function validId(id: unknown): boolean {
  return typeof id === "string" && CHECKPOINT_ID_RE.test(id);
}

/** Validate a git relative path: non-empty, relative, no `..`/NUL. OS-joined. */
export function safeRelPath(rel: string): string {
  if (typeof rel !== "string" || rel.length === 0) throw new Error("empty path");
  if (rel.includes("\0")) throw new Error(`path contains NUL: ${rel}`);
  if (isAbsolute(rel)) throw new Error(`absolute path: ${rel}`);
  const parts = rel.split("/").filter((p) => p.length > 0 && p !== ".");
  if (parts.some((p) => p === "..")) throw new Error(`path traversal: ${rel}`);
  if (parts.length === 0) throw new Error(`empty path: ${rel}`);
  return parts.join(sep);
}

/** Resolve the checkpoint directory for `id` under `privateDir`, validating. */
export function checkpointDir(privateDir: string, id: string): string {
  if (!validId(id)) throw new Error(`invalid checkpoint id: ${String(id)}`);
  const dir = join(resolve(privateDir), id);
  if (!isWithin(resolve(privateDir), dir)) throw new Error(`id escapes private dir: ${id}`);
  return dir;
}

/** Canonicalize the private root; ensure it is a real dir (no symlink escape). */
export async function resolvePrivateRoot(privateDir: string): Promise<string> {
  const real = await realpath(privateDir);
  const st = await lstat(real);
  if (!st.isDirectory()) throw new Error(`private dir is not a directory: ${privateDir}`);
  return real;
}

export function countEntries(files: readonly CheckpointEntry[]): CheckpointCounts {
  let symlinks = 0;
  let totalBytes = 0;
  for (const f of files) {
    if (f.kind === "symlink") symlinks += 1;
    totalBytes += f.size;
  }
  return { files: files.length, symlinks, totalBytes };
}

/** Validate a bound is a positive finite integer; clamp to the hard cap. */
export function clampBound(name: string, v: number | undefined, hard: number): number {
  if (v === undefined) return hard;
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v) || v <= 0) {
    throw new Error(`${name} must be a positive finite integer`);
  }
  return Math.min(v, hard);
}

/** Walk parents of POSIX-relative `rel`; reject symlinked/non-dir ancestors. */
export async function ancestorsSafe(
  realRoot: string,
  rel: string,
  allowMissing = false,
): Promise<boolean> {
  const parts = rel.split("/").filter((p) => p.length > 0 && p !== ".");
  for (let i = 0; i < parts.length - 1; i += 1) {
    const st = await lstat(join(realRoot, ...parts.slice(0, i + 1))).catch(() => undefined);
    if (st === undefined) {
      if (allowMissing) continue;
      return false;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
  }
  return true;
}

/** sha256 of a file's bytes (via O_NOFOLLOW) or of a symlink's target string. */
export async function hashPath(path: string, kind: "file" | "symlink"): Promise<string | null> {
  if (kind === "symlink") {
    const { readlink } = await import("node:fs/promises");
    const target = await readlink(path).catch(() => undefined);
    return target === undefined ? null : createHash("sha256").update(target).digest("hex");
  }
  const fh = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => undefined);
  if (!fh) return null;
  try {
    const hash = createHash("sha256");
    const buf = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const n = await fh.read(buf, 0, buf.length, null);
      if (n.bytesRead <= 0) break;
      hash.update(buf.subarray(0, n.bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** Write bytes exclusively (0600, O_EXCL); refuses to clobber an existing file. */
export async function writeExclusive(path: string, data: Buffer | string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  const fh = await open(path, OPEN_EXCL, 0o600);
  try {
    await fh.writeFile(typeof data === "string" ? Buffer.from(data, "utf8") : data);
  } finally {
    await fh.close().catch(() => undefined);
  }
}

// --- symlink verification (target string only; never read the stored path) ---

/** sha256 of a symlink target string, matching capture-time hashing. */
export function hashTarget(target: string): string {
  return createHash("sha256").update(target).digest("hex");
}

// --- manifest validation -----------------------------------------------------

/** Hard bound on manifest size and entry count accepted on read. */
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
export const MAX_MANIFEST_FILES = 2000;
const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Credential/config path segments that must never appear in a manifest entry,
 * even if the manifest was tampered with. Matched on exact component or file
 * name, using the same default policy as tools and shell execution.
 */
export function isProtectedRelPath(rel: string): boolean {
  return isProtectedRelativePath(rel);
}

function bad(msg: string): never {
  throw new Error(`invalid checkpoint manifest: ${msg}`);
}

function validateEntry(entry: unknown, index: number): CheckpointEntry {
  if (typeof entry !== "object" || entry === null) bad(`entry ${index} not an object`);
  const e = entry as Record<string, unknown>;
  if (typeof e.path !== "string" || e.path.length === 0) bad(`entry ${index} bad path`);
  try {
    safeRelPath(e.path);
  } catch (error) {
    bad(`entry ${index} ${(error as Error).message}`);
  }
  if (isProtectedRelPath(e.path)) bad(`entry ${index} references a protected path: ${e.path}`);
  if (e.kind !== "file" && e.kind !== "symlink") bad(`entry ${index} bad kind: ${String(e.kind)}`);
  if (typeof e.sha256 !== "string" || !SHA256_RE.test(e.sha256)) bad(`entry ${index} bad sha256`);
  if (typeof e.size !== "number" || !Number.isInteger(e.size) || e.size < 0) bad(`entry ${index} bad size`);
  if (typeof e.mode !== "number" || !Number.isInteger(e.mode) || e.mode < 0 || e.mode > 0o777) {
    bad(`entry ${index} bad mode`);
  }
  if (e.kind === "symlink") {
    if (typeof e.target !== "string") bad(`entry ${index} symlink missing target string`);
    if (e.sha256 !== hashTarget(e.target)) bad(`entry ${index} symlink target hash mismatch`);
    if (e.size !== Buffer.byteLength(e.target)) bad(`entry ${index} symlink target size mismatch`);
  }
  return e as unknown as CheckpointEntry;
}

/**
 * Parse and structurally validate manifest JSON. `expectedRoot` (canonical) and
 * `expectedId`, when supplied, must match — preventing a checkpoint from a
 * different project or id being applied to the wrong tree.
 */
export function parseManifest(raw: string, expected: { id?: string; root?: string } = {}): CheckpointManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    bad("not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) bad("not an object");
  const m = parsed as Record<string, unknown>;
  if (m.version !== undefined && m.version !== 1) bad(`unsupported version: ${String(m.version)}`);
  if (typeof m.id !== "string" || !validId(m.id)) bad(`bad id: ${String(m.id)}`);
  if (typeof m.root !== "string" || m.root.length === 0) bad("bad root");
  if (typeof m.createdAt !== "string") bad("bad createdAt");
  if (typeof m.complete !== "boolean") bad("bad complete");
  if (!Array.isArray(m.reasons) || m.reasons.some((r) => typeof r !== "string")) bad("bad reasons");
  if (!Array.isArray(m.files)) bad("files not an array");
  if (m.files.length > MAX_MANIFEST_FILES) bad(`too many files: ${m.files.length}`);
  if (expected.id !== undefined && m.id !== expected.id) bad(`id mismatch: ${m.id} != ${expected.id}`);
  if (expected.root !== undefined && m.root !== expected.root) {
    bad(`root mismatch: ${m.root} != ${expected.root}`);
  }
  const files = m.files.map((e, i) => validateEntry(e, i));
  return { ...(m as unknown as CheckpointManifest), files };
}
