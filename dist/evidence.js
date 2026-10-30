import { isProtectedRelativePath, resolveProtectedPaths } from "./path-protection.js";
// ---------------------------------------------------------------------------
// integration/evidence.ts
//
// Self-contained evidence helpers for the pi-durable-share workflow. Node
// builtins only (no node_modules): type-strip and run under Node 22 with
//   node --experimental-strip-types ...
//
// Guarantees:
//   - captureSnapshot(root, options): enumerate the working tree via git
//     (`ls-files -z --cached --others --exclude-standard`, unborn-repo safe,
//     ambient repo helpers disabled, 10s timeout, clean limited env), skip
//     protected/credential paths, walk every parent directory rejecting
//     symlinked/escaping ancestors before any leaf read, hash regular files
//     (bytes) and symlinks (target string only), never read secret contents,
//     and bound files/bytes with explicit, validated incompleteness. A normal
//     tracked deletion (ENOENT) is excluded without marking incomplete.
//   - compareSnapshots(before, after): content/mode diff vs a baseline. An
//     unchanged file that was already present in `before` is not "changed".
//   - verifySnapshot(root, snapshot, options): re-hash and report stale files.
//   - writeArtifact(dir, id, data, opts): immutable 0600 file under a caller
//     private 0700 directory; strict id, no traversal, no overwrite; optional
//     `sanitize` scrubs the serialized UTF-8 text (no implicit redaction).
//   - sanitizeCommandResult(result, options): bounded public summary of a
//     command result; never claims success, preserves nonzero exit codes.
// ---------------------------------------------------------------------------
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readlink, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
// ---------------------------------------------------------------------------
// limits
// ---------------------------------------------------------------------------
/** Hard cap on the number of files captured; caller values are clamped to it. */
export const HARD_MAX_FILES = 2000;
/** Hard cap on per-file bytes hashed/copied; caller values are clamped to it. */
export const HARD_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Defaults derive from the hard caps. */
export const DEFAULT_MAX_FILES = HARD_MAX_FILES;
export const DEFAULT_MAX_FILE_BYTES = HARD_MAX_FILE_BYTES;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
/**
 * Validate a numeric option bound. Non-finite / non-integer / non-positive
 * values throw (so `maxFiles: 0` is an explicit error, never a silent no-op);
 * finite values above the hard cap are clamped down to the cap.
 */
function resolveBound(name, value, hardMax) {
    if (value === undefined)
        return hardMax;
    if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
        throw new Error(`${name} must be a finite integer`);
    }
    if (!Number.isInteger(value))
        throw new Error(`${name} must be a finite integer`);
    if (value <= 0)
        throw new Error(`${name} must be a positive integer`);
    return Math.min(value, hardMax);
}
// ---------------------------------------------------------------------------
// protected paths
// ---------------------------------------------------------------------------
/** Credential/state files that must never be hashed or copied. */
export const PROTECTED_FILES = [
    ".env",
    ".env.local",
    "config.local.json",
    ".secrets",
    ".runtime",
];
/** Directory names (anywhere in the tree) that are never read. */
export { PROTECTED_NAMES } from "./path-protection.js";
function isProtectedRelative(rel) {
    return isProtectedRelativePath(rel.split(sep).join("/"));
}
function isProtectedByList(root, rel, list) {
    const abs = resolve(root, rel);
    return list.some((p) => {
        const target = isAbsolute(p) ? resolve(p) : resolve(root, p);
        return abs === target || isWithin(target, abs);
    });
}
// ---------------------------------------------------------------------------
// containment
// ---------------------------------------------------------------------------
/** Lexically resolved containment: is `p` inside directory `parent`? */
function isWithin(parent, p) {
    const rel = relative(resolve(parent), resolve(p));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
/**
 * Walk every parent directory of `rel` (relative to `realRoot`) and reject any
 * symlinked, missing, non-directory, or escaping ancestor. This is the real
 * defense against a tracked path whose ancestor was swapped for a symlink that
 * points outside the checkout: it runs BEFORE the leaf is ever touched, for
 * regular files and symlink leaves alike.
 */
async function checkAncestors(realRoot, rel) {
    const parts = rel.split("/").filter((p) => p.length > 0 && p !== ".");
    for (let i = 0; i < parts.length - 1; i += 1) {
        const prefix = parts.slice(0, i + 1).join(sep);
        const abs = join(realRoot, prefix);
        let st;
        try {
            st = await lstat(abs);
        }
        catch (error) {
            const code = error.code;
            if (code === "ENOENT")
                return { ok: false, reason: `ancestor-missing:${prefix}` };
            return { ok: false, reason: `ancestor-stat-failed:${code ?? "unknown"}` };
        }
        if (st.isSymbolicLink())
            return { ok: false, reason: `ancestor-symlink:${prefix}` };
        if (!st.isDirectory())
            return { ok: false, reason: `ancestor-not-directory:${prefix}` };
        let real;
        try {
            real = await realpath(abs);
        }
        catch (error) {
            return { ok: false, reason: `ancestor-realpath-failed:${error.message}` };
        }
        if (!isWithin(realRoot, real))
            return { ok: false, reason: `ancestor-escape:${prefix}` };
    }
    return { ok: true };
}
// ---------------------------------------------------------------------------
// git enumeration
// ---------------------------------------------------------------------------
/**
 * A deliberately small environment for the git child: system/runtime values the
 * binary needs (PATH, HOME, temp dirs), but no API keys/tokens — the host keeps
 * those in closure. Ambient repo-command helpers are disabled via -c flags.
 */
function cleanGitEnv() {
    const allow = [
        "PATH",
        "HOME",
        "TMPDIR",
        "TMP",
        "TEMP",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "SYSTEMROOT",
        "SystemRoot",
        "COMSPEC",
        "PATHEXT",
        "WINDIR",
    ];
    const env = {};
    for (const key of allow) {
        const value = process.env[key];
        if (typeof value === "string")
            env[key] = value;
    }
    return env;
}
/**
 * Enumerate tracked + untracked-not-ignored files (NUL separated) via a
 * hardened, read-only git invocation. Repo-configured helpers (`core.fsmonitor`
 * hooks, `core.hooksPath`) are disabled so a hostile checkout cannot execute
 * code during enumeration; `--no-optional-locks` keeps it strictly read-only.
 * A 10s timeout and `maxBuffer` bound the child. Failures are reported, never
 * thrown.
 */
function listFiles(root) {
    const args = [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "--no-optional-locks",
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
    ];
    const res = spawnSync("git", args, {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        env: cleanGitEnv(),
    });
    if (res.error)
        return { rels: [], error: `git ls-files failed to run: ${res.error.message}` };
    if (res.signal)
        return { rels: [], error: `git ls-files killed by ${res.signal}` };
    if (res.status !== 0) {
        const err = (res.stderr ?? "").trim().split("\n").slice(0, 3).join(" ");
        return { rels: [], error: `git ls-files exited ${res.status}: ${err}` };
    }
    const rels = String(res.stdout ?? "")
        .split("\0")
        .filter((s) => s.length > 0);
    return { rels };
}
function defaultSanitize(s) {
    return s;
}
/**
 * Hash exactly `maxFileBytes` of a regular file, reporting the true size. The
 * file is opened `O_NOFOLLOW` (a swapped-in final symlink is refused) and its
 * descriptor stat is re-checked so metadata is consistent with the open file.
 */
async function hashRegularFile(absPath, maxFileBytes) {
    const handle = await open(absPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
        const stat = await handle.stat();
        if (!stat.isFile())
            throw new Error("not_a_regular_file");
        const hash = createHash("sha256");
        const buf = Buffer.allocUnsafe(Math.min(stat.size, maxFileBytes + 1));
        let total = 0;
        while (total < buf.length) {
            const n = await handle.read(buf, total, buf.length - total, total);
            if (n.bytesRead <= 0)
                break;
            total += n.bytesRead;
        }
        const tooLarge = stat.size > maxFileBytes;
        hash.update(buf.subarray(0, Math.min(total, maxFileBytes)));
        return { sha256: hash.digest("hex"), size: stat.size, mode: stat.mode & 0o777, tooLarge };
    }
    finally {
        await handle.close().catch(() => undefined);
    }
}
/**
 * Map a git-emitted path to the OS path separator, WITHOUT rewriting literal
 * backslash characters on POSIX. Git always emits `/` as its path separator;
 * on POSIX a file may legally be named `a\b` and that backslash must survive
 * (it is part of the name). `sep` is `/` on POSIX so this is a no-op there and
 * only rewrites separators on Windows.
 */
function gitPathToOs(rel) {
    return sep === "/" ? rel : rel.split("/").join(sep);
}
/** True when an error is a plain "not there" (a normal tracked deletion). */
function isEnoent(error) {
    return error?.code === "ENOENT";
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
export async function captureSnapshot(root, options = {}) {
    const sanitize = options.sanitize ?? defaultSanitize;
    const protectedPaths = resolveProtectedPaths(root, options.protectedPaths ?? []);
    const maxFiles = resolveBound("maxFiles", options.maxFiles, HARD_MAX_FILES);
    const maxFileBytes = resolveBound("maxFileBytes", options.maxFileBytes, HARD_MAX_FILE_BYTES);
    const reasons = [];
    // Null-prototype map: a file literally named `__proto__` (a valid POSIX name)
    // must be an own entry, not a prototype mutation that silently drops it.
    const files = Object.create(null);
    const capturedAt = new Date().toISOString();
    let realRoot;
    try {
        realRoot = await realpath(root);
    }
    catch (error) {
        return {
            root,
            capturedAt,
            files,
            complete: false,
            reasons: [`root not resolvable: ${sanitize(error.message)}`],
        };
    }
    const listing = listFiles(realRoot);
    if (listing.error !== undefined)
        reasons.push(sanitize(listing.error));
    for (const rel of listing.rels) {
        // Keep the git-emitted name verbatim as the snapshot key.
        if (rel.length === 0)
            continue;
        if (isProtectedRelative(rel) || isProtectedByList(realRoot, gitPathToOs(rel), protectedPaths)) {
            continue;
        }
        if (Object.keys(files).length >= maxFiles) {
            reasons.push(`file cap reached (${maxFiles}); snapshot incomplete`);
            break;
        }
        const absPath = join(realRoot, gitPathToOs(rel));
        // Lexical containment is necessary but not sufficient; the ancestor walk
        // below is what actually blocks a symlinked-parent escape.
        if (!isWithin(realRoot, absPath)) {
            reasons.push(`skipped path outside root: ${rel}`);
            continue;
        }
        // Walk every parent directory first: any symlinked or escaping ancestor is
        // rejected BEFORE we touch the leaf, for regular files AND symlink leaves.
        const ancestors = await checkAncestors(realRoot, rel);
        if (!ancestors.ok) {
            reasons.push(`unsafe ancestor for ${rel}: ${ancestors.reason}`);
            continue;
        }
        let info;
        try {
            info = await lstat(absPath);
        }
        catch (error) {
            // Normal tracked deletion: exclude, do NOT mark incomplete.
            if (isEnoent(error))
                continue;
            reasons.push(`stat failed for ${rel}: ${sanitize(error.message)}`);
            continue;
        }
        if (info.isDirectory())
            continue;
        if (info.isSymbolicLink()) {
            try {
                const target = await readlink(absPath);
                const sha256 = createHash("sha256").update(target).digest("hex");
                files[rel] = { sha256, size: Buffer.byteLength(target), mode: 0o777, kind: "symlink" };
            }
            catch (error) {
                if (isEnoent(error))
                    continue;
                reasons.push(`readlink failed for ${rel}: ${sanitize(error.message)}`);
            }
            continue;
        }
        if (!info.isFile())
            continue;
        try {
            const r = await hashRegularFile(absPath, maxFileBytes);
            if (r.tooLarge)
                reasons.push(`file exceeds ${maxFileBytes} bytes: ${rel}`);
            files[rel] = { sha256: r.sha256, size: r.size, mode: r.mode, kind: "file" };
        }
        catch (error) {
            if (isEnoent(error))
                continue;
            reasons.push(`read failed for ${rel}: ${sanitize(error.message)}`);
        }
    }
    return {
        root: realRoot,
        capturedAt,
        files,
        complete: reasons.length === 0,
        reasons,
    };
}
/**
 * Diff two snapshots. A file present and byte/mode-identical in `before` and
 * `after` is never reported. A file that was already present in `before` and
 * is unchanged is *not* "changed" even if it is untracked — we compare content,
 * not git status.
 */
export function compareSnapshots(before, after) {
    const changedFiles = [];
    const paths = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
    for (const path of [...paths].sort()) {
        const b = before.files[path];
        const a = after.files[path];
        if (b === undefined && a !== undefined) {
            changedFiles.push({ path, kind: "added", afterHash: a.sha256, size: a.size });
            continue;
        }
        if (b !== undefined && a === undefined) {
            changedFiles.push({ path, kind: "deleted", beforeHash: b.sha256 });
            continue;
        }
        if (b === undefined || a === undefined)
            continue;
        const modeChanged = b.mode !== a.mode;
        if (b.sha256 !== a.sha256 || b.kind !== a.kind || modeChanged) {
            changedFiles.push({
                path,
                kind: "modified",
                beforeHash: b.sha256,
                afterHash: a.sha256,
                size: a.size,
            });
        }
    }
    return { changedFiles };
}
/**
 * Confirm that the current tree still matches `snapshot`: every recorded file
 * must re-hash to the same digest (and mode), and deletions are detected. A
 * file that legitimately lives outside the snapshot (protected/new) is ignored;
 * a recorded file that changed or vanished is reported as stale.
 */
export async function verifySnapshot(root, snapshot, options = {}) {
    const now = await captureSnapshot(root, options);
    const staleFiles = [];
    const missingFiles = [];
    const reasons = [];
    for (const path of Object.keys(snapshot.files).sort()) {
        const expected = snapshot.files[path];
        if (expected === undefined)
            continue;
        const actual = now.files[path];
        if (actual === undefined) {
            missingFiles.push(path);
            continue;
        }
        if (actual.sha256 !== expected.sha256 || actual.kind !== expected.kind) {
            staleFiles.push(path);
            continue;
        }
        // A mode-only change on a regular file is also a stale content identity.
        if (expected.kind === "file" && actual.mode !== expected.mode) {
            staleFiles.push(path);
        }
    }
    // The current tree must not contain files that were absent from the snapshot:
    // a file present now but not in `snapshot` is an EXTRA (added) file and makes
    // the verdict stale. This catches a post-snapshot addition the previous
    // snapshot-only loop silently missed.
    const extraFiles = [];
    for (const path of Object.keys(now.files).sort()) {
        if (snapshot.files[path] === undefined && !missingFiles.includes(path)) {
            extraFiles.push(path);
        }
    }
    if (extraFiles.length > 0) {
        for (const path of extraFiles)
            staleFiles.push(path);
        reasons.push(`tree contains ${extraFiles.length} file(s) absent from snapshot`);
    }
    // The current capture itself must be trustworthy for a positive verdict, and
    // so must the ORIGINAL snapshot: an incomplete original cannot be re-verified.
    if (!now.complete)
        reasons.push(...now.reasons);
    if (!snapshot.complete)
        reasons.push("original snapshot was incomplete");
    const ok = staleFiles.length === 0 &&
        missingFiles.length === 0 &&
        now.complete &&
        snapshot.complete;
    return { ok, staleFiles, missingFiles, extraFiles, reasons };
}
// ---------------------------------------------------------------------------
// immutable private artifacts
// ---------------------------------------------------------------------------
/** Strict, traversal-free id: letters, digits, dot, dash, underscore; 1..128. */
const ARTIFACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Deterministic JSON with sorted object keys, so the hash is stable. */
export function stableStringify(value) {
    const seen = new WeakSet();
    const walk = (v) => {
        if (v === null || typeof v !== "object")
            return v;
        if (seen.has(v))
            throw new Error("circular structure");
        seen.add(v);
        if (Array.isArray(v))
            return v.map(walk);
        const out = {};
        for (const key of Object.keys(v).sort()) {
            out[key] = walk(v[key]);
        }
        return out;
    };
    return JSON.stringify(walk(value));
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
export async function writeArtifact(privateEvidenceDir, id, data, options = {}) {
    const sanitize = options.sanitize ?? defaultSanitize;
    const cap = Math.min(options.maxBytes ?? MAX_ARTIFACT_BYTES, MAX_ARTIFACT_BYTES);
    if (typeof id !== "string" || !ARTIFACT_ID_RE.test(id)) {
        throw new Error(`invalid artifact id: ${sanitize(String(id))}`);
    }
    let bytes;
    if (typeof data === "string") {
        // Scrub the serialized UTF-8 text when a sanitizer is provided.
        bytes = Buffer.from(options.sanitize ? sanitize(data) : data, "utf8");
    }
    else if (data instanceof Uint8Array) {
        // Raw bytes are the caller's responsibility: we cannot redact opaque binary.
        bytes = Buffer.from(data);
    }
    else {
        const text = stableStringify(data);
        bytes = Buffer.from(options.sanitize ? sanitize(text) : text, "utf8");
    }
    if (bytes.byteLength > cap) {
        throw new Error(`artifact exceeds ${cap} bytes (${bytes.byteLength})`);
    }
    const dir = resolve(privateEvidenceDir);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, id);
    if (!isWithin(dir, target))
        throw new Error(`artifact id escapes directory: ${id}`);
    // Refuse a pre-existing symlink or non-regular entry explicitly (O_EXCL alone
    // reports EEXIST for a symlink, which would be misread as a plain conflict).
    const existing = await lstat(target).catch(() => undefined);
    if (existing !== undefined) {
        if (existing.isSymbolicLink())
            throw new Error(`refusing symlink target: ${sanitize(id)}`);
        throw new Error(`artifact already exists: ${sanitize(id)}`);
    }
    let handle;
    try {
        handle = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    }
    catch (error) {
        const err = error;
        if (err.code === "EEXIST")
            throw new Error(`artifact already exists: ${sanitize(id)}`);
        if (err.code === "ELOOP")
            throw new Error(`refusing symlink target: ${sanitize(id)}`);
        throw new Error(`cannot create artifact: ${sanitize(err.message)}`);
    }
    try {
        await handle.writeFile(bytes);
        await handle.chmod(0o600).catch(() => undefined);
    }
    finally {
        await handle.close().catch(() => undefined);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return { path: target, sha256, bytes: bytes.byteLength };
}
function toBuffer(v) {
    if (v === undefined)
        return Buffer.alloc(0);
    return typeof v === "string" ? Buffer.from(v, "utf8") : Buffer.from(v);
}
function tailUtf8(buf, maxBytes) {
    if (buf.byteLength <= maxBytes)
        return buf.toString("utf8");
    // Slice from the end; a partial multibyte head is harmless for a tail view.
    return buf.subarray(buf.byteLength - maxBytes).toString("utf8");
}
/**
 * Produce a bounded, public-safe summary of a command result. Exact command
 * text is only redacted when the caller supplies `sanitize`; full output is
 * never inlined (the caller persists it separately via writeArtifact). A
 * nonzero exit code is never masked.
 */
export function sanitizeCommandResult(result, options = {}) {
    const sanitize = options.sanitize ?? defaultSanitize;
    const maxInlineBytes = options.maxInlineBytes ?? 4096;
    const rawCommand = result.command ?? result.argv?.join(" ") ?? "";
    const command = sanitize(rawCommand);
    const stdout = toBuffer(result.stdout);
    const stderr = toBuffer(result.stderr);
    const totalBytes = stdout.byteLength + stderr.byteLength;
    const exitCode = result.exitCode ?? null;
    return {
        command,
        exitCode,
        signal: result.signal ?? null,
        timedOut: result.timedOut ?? false,
        durationMs: result.durationMs ?? 0,
        totalBytes,
        truncated: totalBytes > maxInlineBytes * 2,
        // Command OUTPUT is as sensitive as the command line itself: run BOTH tails
        // through the same sanitizer so a secret echoed by a tool never lands in the
        // durable summary unredacted.
        stdoutTail: sanitize(tailUtf8(stdout, maxInlineBytes)),
        stderrTail: sanitize(tailUtf8(stderr, maxInlineBytes)),
        fullOutputPath: null,
        ok: exitCode === 0 && !(result.timedOut ?? false) && (result.signal ?? null) === null,
    };
}
//# sourceMappingURL=evidence.js.map