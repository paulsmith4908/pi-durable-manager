// integration/checkpoint-capture.ts — createCheckpoint: snapshot the working
// tree and copy a private preimage of each file into <privateDir>/<id>/.
// Bounded by maxFiles/maxFileBytes/maxTotalBytes; symlinks recorded as target
// strings only; no git commits; source tree never modified.
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { captureSnapshot, HARD_MAX_FILES, HARD_MAX_FILE_BYTES } from "./evidence.js";
import { ancestorsSafe, checkpointDir, clampBound, countEntries, FILES_DIR, isWithin, MANIFEST_NAME, resolvePrivateRoot, safeRelPath, writeExclusive, } from "./checkpoint-common.js";
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
/** Copy one regular file's bytes into `dest` (0600, O_EXCL), hashing copied bytes. */
async function copyFileBounded(src, dest, maxFileBytes, rel) {
    const handle = await open(src, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch((error) => error);
    if (handle instanceof Error) {
        if (handle.code === "ENOENT")
            return { reason: "missing" };
        return { reason: `open failed: ${handle.code ?? handle.message}` };
    }
    try {
        const st = await handle.stat();
        if (!st.isFile())
            return { reason: "not a regular file" };
        if (st.size > maxFileBytes)
            return { reason: `file exceeds ${maxFileBytes} bytes` };
        await mkdir(join(dest, ".."), { recursive: true, mode: 0o700 });
        const out = await open(dest, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
        const hash = createHash("sha256");
        let total = 0;
        const buf = Buffer.allocUnsafe(64 * 1024);
        try {
            for (;;) {
                const n = await handle.read(buf, 0, buf.length, null);
                if (n.bytesRead <= 0)
                    break;
                await out.write(buf.subarray(0, n.bytesRead));
                hash.update(buf.subarray(0, n.bytesRead));
                total += n.bytesRead;
            }
        }
        finally {
            await out.close().catch(() => undefined);
        }
        if (total !== st.size)
            return { reason: `short read ${total}/${st.size}` };
        return {
            entry: {
                path: rel,
                kind: "file",
                sha256: hash.digest("hex"),
                size: total,
                mode: st.mode & 0o777,
            },
        };
    }
    finally {
        await handle.close().catch(() => undefined);
    }
}
/**
 * Create a checkpoint of `root` under `privateDir/<id>`. Refuses to overwrite an
 * existing checkpoint (O_EXCL). Returns a manifest ref with honest
 * complete/reasons — an incomplete capture is never reported as full.
 */
export async function createCheckpoint(root, privateDir, id, options = {}) {
    const maxFiles = clampBound("maxFiles", options.maxFiles, HARD_MAX_FILES);
    const maxFileBytes = clampBound("maxFileBytes", options.maxFileBytes, HARD_MAX_FILE_BYTES);
    const maxTotalBytes = clampBound("maxTotalBytes", options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
    const realRoot = await resolvePrivateRoot(root);
    const realPrivate = await resolvePrivateRoot(privateDir);
    const dir = checkpointDir(realPrivate, id);
    const snap = await captureSnapshot(realRoot, {
        protectedPaths: options.protectedPaths,
        sanitize: options.sanitize,
        maxFiles,
        maxFileBytes,
    });
    const reasons = [...snap.reasons];
    // Refuse to clobber an existing checkpoint directory.
    const existing = await lstat(dir).catch(() => undefined);
    if (existing !== undefined)
        throw new Error(`checkpoint already exists: ${id}`);
    await mkdir(join(dir, FILES_DIR), { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => undefined);
    const entries = [];
    let totalBytes = 0;
    for (const rel of Object.keys(snap.files).sort()) {
        const meta = snap.files[rel];
        if (meta === undefined) {
            reasons.push(`snapshot entry missing for ${rel}`);
            continue;
        }
        let osRel;
        try {
            osRel = safeRelPath(rel);
        }
        catch (error) {
            reasons.push(`unsafe path ${rel}: ${error.message}`);
            continue;
        }
        if (!isWithin(realRoot, resolve(realRoot, osRel))) {
            reasons.push(`path escapes root: ${rel}`);
            continue;
        }
        if ((await ancestorsSafe(realRoot, rel)) === false) {
            reasons.push(`unsafe ancestor for ${rel}`);
            continue;
        }
        const src = join(realRoot, osRel);
        if (meta.kind === "symlink") {
            try {
                const target = await readlink(src);
                entries.push({
                    path: rel,
                    kind: "symlink",
                    sha256: createHash("sha256").update(target).digest("hex"),
                    size: Buffer.byteLength(target),
                    mode: 0o777,
                    target,
                });
            }
            catch {
                reasons.push(`readlink failed for ${rel}`);
            }
            continue;
        }
        if (totalBytes + meta.size > maxTotalBytes) {
            reasons.push(`total cap reached (${maxTotalBytes}); checkpoint incomplete`);
            break;
        }
        const dest = join(dir, FILES_DIR, osRel);
        if (!isWithin(join(dir, FILES_DIR), dest)) {
            reasons.push(`dest escapes files dir: ${rel}`);
            continue;
        }
        const r = await copyFileBounded(src, dest, maxFileBytes, rel);
        if ("reason" in r) {
            if (r.reason !== "missing")
                reasons.push(`copy failed for ${rel}: ${r.reason}`);
            continue;
        }
        entries.push(r.entry);
        totalBytes += r.entry.size;
    }
    const counts = countEntries(entries);
    const complete = reasons.length === 0;
    const manifest = {
        version: 1,
        id,
        root: realRoot,
        createdAt: new Date().toISOString(),
        files: entries,
        counts,
        complete,
        reasons,
    };
    const manifestPath = join(dir, MANIFEST_NAME);
    await writeExclusive(manifestPath, JSON.stringify(manifest, null, 2));
    return { id, dir, manifest, counts, complete, reasons };
}
//# sourceMappingURL=checkpoint-capture.js.map