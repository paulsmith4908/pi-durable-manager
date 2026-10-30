/**
 * Sandbox primitives for per-project coding tools.
 *
 * This module holds the parts that are independent of the Pi tool registry:
 *   - canonical path-boundary validation (`..`, symlinks, symlink parents),
 *   - protected-path policy (`.git`, `.secrets`, `.runtime`, config/key files),
 *   - a macOS `sandbox-exec` profile builder (write-denied host, project+scratch
 *     read/write, no service socket, no inherited credentials),
 *   - a process-group runner that bounds output, enforces a timeout/AbortSignal,
 *     and terminates the whole process group on completion/abort/timeout.
 *
 * Trusted code (the service) owns the process. Nothing here accepts a
 * model-supplied working directory: callers pass a per-project closure root.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { constants as fsConstants, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { attachStatusChannel, killWatcherGroup, SupervisorProtocolError, SUPERVISOR_VERSION, waitForWatcherGroupGone, } from "./sandbox-supervisor.js";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
/** Absolute path to the macOS sandbox launcher. */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** Protected file/directory names that are never read or written through tools. */
export const PROTECTED_NAMES = [".git", ".secrets", ".runtime", "config.local.json"];
/** Error carrying a machine-readable code; tools convert it to a model-visible result. */
export class ToolError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "ToolError";
        this.code = code;
    }
}
/**
 * Canonicalize an absolute path for boundary comparison.
 *
 * realpath of the nearest existing ancestor, then re-append the non-existent
 * tail. This collapses OS aliases (`/var` <-> `/private/var`, `/tmp` <->
 * `/private/tmp`, `/etc` <-> `/private/etc`) so a lexical root and a realpath'd
 * descendant compare consistently. Failures fall back to the lexical `resolve`
 * so policy construction never throws on a path the caller owns.
 */
function canonicalizeForPolicy(absPath) {
    try {
        return realpathSync(absPath);
    }
    catch {
        /* path does not exist (or is not accessible); canonicalize what we can */
    }
    const lexical = resolve(absPath);
    let current = lexical;
    const tail = [];
    for (;;) {
        const parent = dirname(current);
        if (parent === current)
            return lexical;
        tail.unshift(current.slice(parent.length + 1));
        current = parent;
        try {
            const real = realpathSync(current);
            return resolve(tail.length === 0 ? real : join(real, ...tail));
        }
        catch {
            /* keep walking up */
        }
    }
}
/**
 * Resolve policy defaults; the root must be absolute.
 *
 * `root`, `scratchDir`, and every `protectedPaths` entry are canonicalized
 * (realpath of the existing path, or of the nearest existing ancestor) so that
 * boundary comparisons are performed on canonical paths. This is what makes a
 * fixture root reported by `os.tmpdir()` as `/var/...` compare equal to the
 * kernel's `/private/var/...` realpath rather than being rejected as an escape.
 */
export function resolvePolicy(policy) {
    if (!isAbsolute(policy.root)) {
        throw new ToolError("invalid_argument", `project root must be absolute: ${policy.root}`);
    }
    const root = canonicalizeForPolicy(policy.root);
    const protectedPaths = (policy.protectedPaths ?? []).map((p) => canonicalizeForPolicy(p));
    const scratchDir = policy.scratchDir !== undefined ? canonicalizeForPolicy(policy.scratchDir) : undefined;
    // Refuse an ambiguous scratch: the host-controlled carve-out must be a distinct
    // tree, never the project root and never a protected credential/config path
    // (which would lift protections the caller asked for). A scratch that is
    // *inside* a protected directory is fine — the profile carves out only the
    // assigned subtree — but an exact match is not.
    if (scratchDir !== undefined) {
        if (resolve(scratchDir) === resolve(root)) {
            throw new ToolError("invalid_argument", "scratchDir must be distinct from the project root");
        }
        for (const p of protectedPaths) {
            if (resolve(scratchDir) === resolve(p)) {
                throw new ToolError("invalid_argument", "scratchDir must be distinct from a protected path");
            }
        }
    }
    return {
        root,
        protectedPaths,
        ...(scratchDir !== undefined ? { scratchDir } : {}),
        sandboxExec: policy.sandboxExec ?? SANDBOX_EXEC,
        allowNetwork: policy.allowNetwork ?? false,
        // Omitted or explicit null => UNLIMITED. No magic sentinel / huge number.
        timeoutMs: policy.timeoutMs ?? null,
        maxOutputBytes: policy.maxOutputBytes ?? 200_000,
    };
}
/** True when `child` equals `parent` or is inside it (lexical, resolved). */
export function isWithin(parent, child) {
    const p = resolve(parent);
    const c = resolve(child);
    if (p === c)
        return true;
    return c.startsWith(p.endsWith(sep) ? p : p + sep);
}
/**
 * True when the path names a protected component at or below `root`.
 *
 * Only components *relative to the project root* count: a project whose own
 * absolute path happens to contain a protected-looking segment (for example an
 * ancestor directory named `.runtime`) must not have its entire tree rejected.
 */
function namesProtected(root, absPath) {
    const rel = relative(resolve(root), resolve(absPath));
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
        return false;
    const parts = rel.split(sep);
    return PROTECTED_NAMES.some((name) => parts.includes(name));
}
/**
 * Validate a model-supplied path against the project boundary and return the
 * canonical absolute path.
 *
 * Rejects: non-absolute root reuse, `..` traversal, symlink target outside the
 * root, symlink in a parent component outside the root, and protected paths.
 * For writes, the target need not exist; the nearest existing ancestor is
 * canonicalized so a symlinked parent cannot escape.
 */
export async function resolveWithinRoot(policy, inputPath, mode) {
    if (typeof inputPath !== "string" || inputPath.length === 0) {
        throw new ToolError("invalid_argument", "path must be a non-empty string");
    }
    if (inputPath.includes("\0")) {
        throw new ToolError("invalid_argument", "path must not contain NUL");
    }
    if (isAbsolute(inputPath)) {
        throw new ToolError("invalid_argument", `path must be relative to the project root, got absolute: ${inputPath}`);
    }
    // Lexical containment first: reject obvious `..` escapes before touching disk.
    const lexical = resolve(policy.root, inputPath);
    if (!isWithin(policy.root, lexical)) {
        throw new ToolError("outside_root", `path escapes project root: ${inputPath}`);
    }
    assertNotProtected(policy, lexical);
    // Canonicalize the nearest existing ancestor so symlinked parents are checked.
    const canonical = await canonicalizeNearest(policy.root, lexical, mode);
    if (!isWithin(policy.root, canonical)) {
        throw new ToolError("outside_root", `path resolves outside project root: ${inputPath}`);
    }
    assertNotProtected(policy, canonical);
    return canonical;
}
/** Reject any path in the protected set or containing a protected component. */
function assertNotProtected(policy, absPath) {
    if (namesProtected(policy.root, absPath)) {
        throw new ToolError("protected_path", `path is protected: ${absPath}`);
    }
    for (const protectedPath of policy.protectedPaths) {
        if (isWithin(protectedPath, absPath) || absPath === protectedPath) {
            throw new ToolError("protected_path", `path is protected: ${absPath}`);
        }
        if (namesProtected(policy.root, protectedPath) && isWithin(dirname(protectedPath), absPath)) {
            // A passed protected directory's children are also protected.
        }
    }
}
/**
 * Canonicalize `lexical` by walking up to the nearest existing ancestor,
 * realpath-ing it, then re-appending the non-existent tail. This catches a
 * symlinked parent directory that points outside the root even when the final
 * component does not exist yet.
 */
async function canonicalizeNearest(root, lexical, mode) {
    let current = lexical;
    const tail = [];
    for (;;) {
        let info;
        try {
            info = await lstat(current);
        }
        catch {
            info = undefined;
        }
        if (info !== undefined) {
            const real = await realpath(current);
            const combined = tail.length === 0 ? real : join(real, ...tail.reverse());
            return resolve(combined);
        }
        if (resolve(current) === resolve(root)) {
            // Root itself must exist for a project.
            throw new ToolError("not_found", `project root does not exist: ${root}`);
        }
        const parent = dirname(current);
        if (parent === current) {
            throw new ToolError("outside_root", `could not resolve path: ${lexical}`);
        }
        tail.push(current.slice(parent.length + 1));
        current = parent;
    }
    void mode;
}
/**
 * Final-component safety check: if the target exists and is a symlink, reject
 * (callers use O_NOFOLLOW where possible). Returns lstat info or undefined.
 */
export async function lstatOrUndefined(absPath) {
    try {
        return await lstat(absPath);
    }
    catch {
        return undefined;
    }
}
/** Open flags that refuse to follow a final symlink. */
export const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
/**
 * Write `content` to `absPath` without following a final symlink (O_NOFOLLOW),
 * creating the file with private (0600) mode. `O_CREAT | O_TRUNC | O_WRONLY`.
 * A final-component symlink is refused (ELOOP) rather than followed.
 */
export async function writeFileNoFollow(absPath, content) {
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | O_NOFOLLOW;
    let handle;
    try {
        handle = await open(absPath, flags, 0o600);
    }
    catch (error) {
        const err = error;
        if (err.code === "ELOOP") {
            throw new ToolError("protected_path", `refusing to write through symlink: ${absPath}`);
        }
        if (err.code === "EISDIR") {
            throw new ToolError("is_directory", `is a directory: ${absPath}`);
        }
        throw new ToolError("spawn_error", `cannot write ${absPath}: ${err.message}`);
    }
    try {
        await handle.writeFile(content, "utf8");
        // Enforce private permissions even if the file pre-existed with looser mode.
        await handle.chmod(0o600).catch(() => undefined);
    }
    finally {
        await handle.close().catch(() => undefined);
    }
}
/** Open a file for reading without following a final symlink, returning its bytes. */
export async function readFileNoFollow(absPath, maxBytes) {
    const info = await lstatOrUndefined(absPath);
    if (info === undefined)
        throw new ToolError("not_found", `no such file: ${absPath}`);
    if (info.isDirectory())
        throw new ToolError("is_directory", `is a directory: ${absPath}`);
    if (info.isSymbolicLink()) {
        // A symlink target was already validated by resolveWithinRoot; opening with
        // O_NOFOLLOW refuses a final-component symlink swap (TOCTOU).
    }
    let handle;
    try {
        handle = await open(absPath, fsConstants.O_RDONLY | O_NOFOLLOW);
    }
    catch (error) {
        throw new ToolError("not_found", `cannot open ${absPath}: ${error.message}`);
    }
    try {
        const stat = await handle.stat();
        if (stat.size > maxBytes) {
            throw new ToolError("too_large", `file exceeds ${maxBytes} bytes: ${absPath}`);
        }
        return await handle.readFile();
    }
    finally {
        await handle.close().catch(() => undefined);
    }
}
// ---------------------------------------------------------------------------
// sandbox-exec profile
// ---------------------------------------------------------------------------
/** Escape a string for use inside an SBPL string literal. */
function sbpl(value) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
/**
 * The assigned scratch subtree that may be carved out of an otherwise-protected
 * ancestor, or `null` when no carve-out is legal.
 *
 * A carve-out is only ever granted for the *host-controlled* assigned scratch
 * (`policy.scratchDir`) and only when it is a **strict** descendant of the
 * ancestor. Equality is refused: allowing `PROTECTED` itself defeats the whole
 * point. The scratch is never model supplied (the service owns the process), so
 * this is a fixed, trusted path — but we still refuse a scratch that equals the
 * project root or any protected credential path, since a nested layout would
 * otherwise silently widen the protected tree.
 */
function scratchExceptionFor(policy, ancestor) {
    const scratch = policy.scratchDir;
    if (scratch === undefined)
        return null;
    // Must be strictly inside the ancestor; equality is not a carve-out.
    if (resolve(scratch) === resolve(ancestor))
        return null;
    if (!isWithin(ancestor, scratch))
        return null;
    // Never carve scratch out of the project root or an explicit credential path
    // when that would expose the project/credential itself. scratch === root would
    // already be caught above only if root is the ancestor; guard the equivalence
    // explicitly for clarity and defence in depth.
    if (resolve(scratch) === resolve(policy.root))
        return null;
    return scratch;
}
/**
 * Emit a read+write deny for `ancestor`, but *excluding* `exception` when it is
 * a legal assigned-scratch carve-out.
 *
 * SBPL later rules win, so a plain `(deny ... (subpath ancestor))` placed after
 * the scratch allow-rule overrides it and makes the scratch unwritable. The
 * filter form keeps the ancestor denied while re-permitting exactly the trusted
 * scratch subtree:
 *
 *   (deny file-read* file-write*
 *     (require-all
 *       (subpath "/protected/state")
 *       (require-not (subpath "/protected/state/scratch/<id>"))))
 *
 * Every sibling under `ancestor` (e.g. `state/secret.txt`) remains denied, and
 * the ancestor itself is never lifted wholesale.
 */
function denyWithScratchException(policy, ancestor, rules) {
    const exception = scratchExceptionFor(policy, ancestor);
    if (exception === null) {
        rules.push(`(deny file-read* file-write* (subpath "${sbpl(ancestor)}"))`);
        return;
    }
    rules.push([
        "(deny file-read* file-write*",
        "  (require-all",
        `    (subpath "${sbpl(ancestor)}")`,
        `    (require-not (subpath "${sbpl(exception)}"))))`,
    ].join("\n"));
}
/**
 * Real user-home private-state trees the profile always denies.
 *
 * These are *specific private state/key paths*, not the whole of `/private/var`.
 * A blanket `(deny file-read* (subpath "/private/var/db"))` breaks dyld and the
 * toolchain (the kernel aborts the child before any code runs), so we deny the
 * actual credential/config/control state instead, leaving the OS's public
 * read/process services available through the `(allow default)` base.
 */
function privateReadDenyRoots() {
    const home = process.env.HOME;
    const out = ["/private/var/root", "/private/etc/ssh", "/etc/ssh"];
    if (home && isAbsolute(home) && home !== "/") {
        out.push(join(home, ".ssh"), join(home, ".aws"), join(home, ".config"), join(home, ".gnupg"), join(home, "Library/Keychains"));
    }
    return out;
}
/**
 * The real user home to deny for reads, or null when it should not be denied.
 *
 * In production `process.env.HOME` is the operator's real home, which holds
 * private config/keys. We deny reading it wholesale (rather than enumerating
 * every dotdir) but re-allow the project/scratch trees below, so a project that
 * lives inside the home still works while unrelated home contents stay hidden.
 */
function realUserHome() {
    const home = process.env.HOME;
    if (!home || !isAbsolute(home) || home === "/")
        return null;
    return home;
}
/**
 * Build the SBPL profile for a command.
 *
 * Architecture (proven on real macOS): start from the working
 * `(allow default)` base — this gives the child the OS runtime/mach-service
 * access it needs to start at all (without it, `sandbox-exec ... /usr/bin/true`
 * aborts with SIGABRT before dyld finishes) — then layer *explicit controls* on
 * top. In SBPL later rules win, so each control below is ordered after the
 * broader rule it refines:
 *
 *   1. `(allow default)`                      — OS public runtime/process access
 *   2. `(deny file-write*)`                   — no writes anywhere…
 *   3. `(allow file-write* (subpath proj))`   — …except the project + scratch
 *   4. real user home denied read, then the project/scratch re-allowed read
 *   5. protected project names denied read+write (`.git`, `.secrets`, …)
 *   6. private config/key/control-state trees denied read+write; the assigned
 *      scratch is carved out with `require-not` when it is nested inside one
 *   6b. exact ancestor directories of project+scratch re-allowed
 *      `file-read-metadata` (literal only) so Node's `realpathSync` walk of a
 *      project nested under the (denied) real home succeeds — without exposing
 *      any ancestor's contents or listing
 *   7. network denied first (`(deny network*)`), then — only with `allowNetwork`
 *      — filtered re-allows: outbound IP `"*:*"` (npm HTTPS + dev servers),
 *      loopback bind/inbound, and unix sockets *under the project/scratch trees
 *      only*. Control/outside unix sockets are re-denied LAST, after the allows,
 *      so they stay blocked via both raw path and `/var` alias. There is never a
 *      blanket `(allow network-outbound)`.
 *
 * A protected ancestor that *contains* the assigned scratch (the production
 * layout: `<stateDir>/scratch/<id>`) is denied with a filter that excludes only
 * the trusted scratch subtree. Its siblings stay denied and the ancestor itself
 * is never lifted, so credentials/config alongside the scratch remain protected.
 *
 * This is a *real* enforced sandbox, not an unsandboxed fallback: writes are
 * confined to the project+scratch, private state is unreadable, and the control
 * socket is unreachable. Network is deny-by-default in every case; `allowNetwork`
 * only widens it to outbound IP, loopback servers, and unix sockets inside the
 * project/scratch, never to the manager control socket. It deliberately does not
 * enumerate every mach service, because over-denying the OS runtime is what
 * produced the earlier SIGABRT.
 */
export function buildSandboxProfile(policy) {
    const writable = [policy.root, ...(policy.scratchDir ? [policy.scratchDir] : [])];
    const rules = ["(version 1)", "(allow default)"];
    // (2) Confinement: deny every write, then (3) re-allow only project+scratch.
    rules.push("(deny file-write*)");
    for (const dir of writable) {
        rules.push(`(allow file-write* (subpath "${sbpl(dir)}"))`);
    }
    rules.push('(allow file-read* file-write* (literal "/dev/null"))');
    rules.push('(allow file-read* file-write* (literal "/dev/stdout"))');
    rules.push('(allow file-read* file-write* (literal "/dev/stderr"))');
    // (4) Deny reads of the real user home wholesale (private config/keys/caches
    // live there), then re-allow the project + scratch so a project nested inside
    // the home still works. Ordered before the protected-path denials so that a
    // protected name inside the project (e.g. `<root>/.secrets`) still wins.
    //
    // When the assigned scratch itself lives *under* the real home, the wholesale
    // home read-deny would shadow the scratch re-allow below it. Emit the home
    // deny as a scratch-aware filter in that case so the trusted scratch stays
    // readable while the rest of the home remains hidden.
    const home = realUserHome();
    if (home) {
        const homeException = scratchExceptionFor(policy, home);
        if (homeException === null) {
            rules.push(`(deny file-read* (subpath "${sbpl(home)}"))`);
        }
        else {
            rules.push([
                "(deny file-read*",
                "  (require-all",
                `    (subpath "${sbpl(home)}")`,
                `    (require-not (subpath "${sbpl(homeException)}"))))`,
            ].join("\n"));
        }
        for (const dir of writable) {
            rules.push(`(allow file-read* (subpath "${sbpl(dir)}"))`);
        }
    }
    // (5) Protected names are denied *at or below the project root* only. This is
    // scoped with `subpath "<root>/<name>"` rather than a global regex, because a
    // project may legitimately live inside an ancestor directory named `.runtime`
    // (scratch/state often does). Ordered after the project allow-rules so it wins.
    for (const name of PROTECTED_NAMES) {
        const protectedPath = join(policy.root, name);
        rules.push(`(deny file-read* file-write* (subpath "${sbpl(protectedPath)}"))`);
        rules.push(`(deny file-read* file-write* (literal "${sbpl(protectedPath)}"))`);
    }
    // (6) Private state: real user home configs, keys, ssh, and control state are
    // unreadable/unwritable even though the base allows reads elsewhere. When the
    // assigned scratch is nested inside one of these ancestors (scratch commonly
    // lives under state/config), deny with an explicit scratch carve-out so the
    // ancestor's other contents stay protected.
    for (const dir of privateReadDenyRoots()) {
        denyWithScratchException(policy, dir, rules);
    }
    for (const dir of policy.protectedPaths) {
        denyWithScratchException(policy, dir, rules);
        rules.push(`(deny file-read* file-write* (literal "${sbpl(dir)}"))`);
    }
    // (6b) Ancestor metadata: allow `lstat`/`stat` of the *exact* ancestor
    // directories of the project and scratch trees — and nothing else.
    //
    // Node's module loader and `node --test` call `fs.realpathSync`/`lstat` on
    // every directory from `/` down to the project file. When the project or
    // scratch lives under the real home (or any other denied ancestor), the
    // wholesale `(subpath home)` read-deny above blocks that metadata walk and
    // Node aborts with EPERM before any test runs. Emitting one *literal*
    // metadata allow per ancestor directory — ordered AFTER the home/protected
    // denials so last-match-wins re-permits exactly those directory inodes —
    // makes the walk succeed.
    //
    // Scoping is deliberate: `(literal <dir>)` + `file-read-metadata` permits
    // stat/access of that directory entry only. It does NOT permit
    // `file-read-data`, so directory enumeration (`readdir`) and file contents
    // under the ancestor stay denied, and no *other* home directory is exposed.
    // The list is finite (the ancestor chain of root+scratch), never a `subpath`,
    // so nothing below an ancestor is re-opened.
    for (const dir of ancestorMetadataAllowList(policy)) {
        rules.push(`(allow file-read-metadata (literal "${sbpl(dir)}"))`);
    }
    // (7) Network: denied by default. The control unix-socket paths are denied
    // unconditionally (never lifted by allowNetwork) so a worker can never reach
    // the service socket or accept its own work.
    //
    // The previous implementation emitted the control-socket denials FIRST and then
    // a blanket `(allow network-inbound)/(allow network-outbound)` for the dev
    // case. Because SBPL is last-match-wins, that blanket allow *overrode every
    // earlier denial* and the sandboxed child could reach the manager control
    // socket. The fix is the opposite shape: start from `(deny network*)` and add
    // back only the narrow, host-controlled allowances a dev server legitimately
    // needs.
    rules.push("(deny network*)");
    if (policy.allowNetwork) {
        // Development case. A worker that runs `npm install` needs outbound HTTPS to
        // the registry, and a worker that runs its own test suite needs to *start* a
        // loopback TCP/unix server and accept its own connections. The earlier
        // loopback-only outbound (`localhost:*`) was too narrow for npm and the
        // inbound side was denied outright, so a self-test socket server could not
        // listen. These allow-rules are still explicitly *filtered* — there is no
        // bare `(allow network-outbound)` — and the control-socket denials are
        // re-stated afterwards so last-match-wins keeps them blocked regardless.
        // Outbound IP: all interfaces/ports so npm's external HTTPS works. SBPL
        // requires a port in the address, so `"*:*"` is the valid all-hosts form
        // (`"*"` alone is rejected by sandbox-exec with "port missing").
        for (const filter of outboundIpAllowFilters()) {
            rules.push(`(allow network-outbound (remote ip "${sbpl(filter)}"))`);
        }
        // Inbound + bind on loopback only: the child may start a server and accept
        // connections from itself (127.0.0.1 / ::1), but never bind or accept on a
        // routable interface. `network-bind` is required to `listen()` at all.
        for (const filter of loopbackIpFilters()) {
            rules.push(`(allow network-bind (local ip "${sbpl(filter)}"))`);
            rules.push(`(allow network-inbound (local ip "${sbpl(filter)}"))`);
        }
        // Unix-domain sockets are permitted ONLY under the assigned project or
        // scratch trees, for both connecting out and binding/accepting, so a
        // project's own IPC/test server works while the manager control socket
        // (which lives outside both) stays unreachable — irrespective of
        // `/var` <-> `/private/var` path aliases or symlinks.
        //
        // SBPL syntax note: a unix-socket path filter attaches DIRECTLY to the
        // operation as `(allow network-<op> (subpath <dir>))` / `(literal <path>)`
        // — this is exactly how the shipping macOS profiles express it, e.g.
        // application.sb `(allow network-outbound (subpath "/private/var/run"))`
        // and rpcbind.sb `(allow network-bind (literal "/private/var/run/rpcb..."))`.
        // The nested `(remote unix-socket (subpath ...))` form used previously
        // compiles but never matches a real connect/bind (observed as
        // `ownUnix:false` on a real host), so it silently failed to grant the
        // project's own socket. The bare path filter is the enforced form; `local`/
        // `remote` are ONLY valid for ip/tcp/udp literals, not for a path filter.
        for (const dir of unixSocketAllowRoots(policy)) {
            rules.push(`(allow network-outbound (subpath "${sbpl(dir)}"))`);
            rules.push(`(allow network-bind (subpath "${sbpl(dir)}"))`);
            rules.push(`(allow network-inbound (subpath "${sbpl(dir)}"))`);
        }
    }
    // Control/outside unix sockets are ALWAYS blocked, emitted LAST so no earlier
    // allow can lift them (SBPL is last-match-wins). This is re-stated after the
    // `allowNetwork` block on purpose: the project/scratch `subpath` allows above
    // already exclude these trees, and this closes the raw-path and canonical-alias
    // forms even if a caller passes a protected directory that is an ancestor of a
    // permitted root. `/private/var/run` (a common control-socket home) is denied
    // as a literal, and every explicit protected path is denied as subpath+literal.
    //
    // Production layout caveat: the assigned scratch (`<stateDir>/scratch/<id>`)
    // lives *inside* a protected state dir. A plain `(deny network* (subpath
    // stateDir))` here is emitted last and therefore also matches the child's own
    // unix socket under the scratch — re-blocking every scratch Unix socket even
    // though it was just allowed above. So when a protected path is an ancestor of
    // the assigned scratch we emit the subpath deny as a scratch-aware filter,
    // identical in shape to the file policy's `require-not` carve-out. This lifts
    // ONLY the assigned scratch subtree; the protected dir's own literal deny and
    // every other protected/config/credential/socket deny stay exactly as-is.
    rules.push("(deny network* (literal \"/private/var/run\"))");
    rules.push("(deny network* (literal \"/var/run\"))");
    // Host DNS resolution socket (dev case only). With `(deny network*)` in force,
    // the sandboxed child cannot reach the OS resolver's Unix socket, so name
    // lookups fail with `getaddrinfo ENOTFOUND` even though outbound IP is
    // allowed. Apple's shipping profile
    // `/System/Library/Sandbox/Profiles/com.apple.security.XPCTimeStampingService.sb`
    // (line 79) expresses exactly this grant as
    // `(allow network-outbound (literal "/private/var/run/mDNSResponder"))`.
    // We mirror that ONE known OS DNS service socket — canonical and `/var` alias
    // — and nothing else: no blanket unix/network allow, no `/var/run` subpath
    // allow, and the manager control socket (which is not this path) stays
    // denied. Emitted AFTER the generic `/var/run` literal denies above, and
    // BEFORE the explicit `protectedPaths` denies below, so if a caller ever
    // explicitly protects the DNS socket path it remains blocked (last-match-wins).
    if (policy.allowNetwork) {
        for (const dnsSocket of OS_DNS_SOCKET_PATHS) {
            rules.push(`(allow network-outbound (literal "${sbpl(dnsSocket)}"))`);
        }
    }
    for (const dir of policy.protectedPaths) {
        const scratchException = scratchExceptionFor(policy, dir);
        if (scratchException === null) {
            rules.push(`(deny network* (subpath "${sbpl(dir)}"))`);
        }
        else {
            rules.push([
                "(deny network*",
                "  (require-all",
                `    (subpath "${sbpl(dir)}")`,
                `    (require-not (subpath "${sbpl(scratchException)}"))))`,
            ].join("\n"));
        }
        rules.push(`(deny network* (literal "${sbpl(dir)}"))`);
        // `/var` <-> `/private/var` canonical alias of the same protected tree.
        const alias = dir.startsWith("/private/var/") ? dir.slice("/private".length) : undefined;
        if (alias !== undefined) {
            rules.push(`(deny network* (subpath "${sbpl(alias)}"))`);
            rules.push(`(deny network* (literal "${sbpl(alias)}"))`);
        }
    }
    return rules.join("\n") + "\n";
}
/** Outbound IP filters for the dev case: all hosts/ports (npm's HTTPS + dev servers). */
function outboundIpAllowFilters() {
    return ["*:*"];
}
/**
 * The one OS DNS resolution socket the sandbox may reach in the dev case, in
 * canonical (`/private/var/run/...`) and `/var` alias forms. Mirrors Apple's
 * shipping profile line `(allow network-outbound (literal
 * "/private/var/run/mDNSResponder"))` from
 * `/System/Library/Sandbox/Profiles/com.apple.security.XPCTimeStampingService.sb`.
 * Kept as a small, explicit list so the grant stays reviewable and can never
 * broaden into a blanket unix-socket allow.
 */
const OS_DNS_SOCKET_PATHS = ["/private/var/run/mDNSResponder", "/var/run/mDNSResponder"];
/**
 * Loopback IP filters for the dev-server case.
 *
 * Only `localhost` (the kernel's 127.0.0.1 / ::1 aliases) is inbound-allowed; no
 * routable interface is opened for listening. Kept as a small list so a change
 * stays reviewable.
 */
function loopbackIpFilters() {
    return ["localhost:*"];
}
/**
 * The finite set of ancestor directories of the project and scratch trees, most
 * general first, EXCLUDING the project/scratch trees themselves (those are
 * already read-allowed) and excluding anything at or below them.
 *
 * Used to re-permit `lstat`/`stat` (file-read-metadata) of exactly these
 * directory inodes after the home/protected read-denials, so Node's
 * `realpathSync` walk of a project nested under the real home succeeds without
 * exposing any ancestor's contents or listing. Each entry becomes a
 * `(literal "...")` rule — never a `subpath` — so a sibling home directory is
 * not re-opened.
 *
 * The walk stops at the filesystem root; `/` is included because the loader
 * stats it. Canonicalization collapses `/var` <-> `/private/var` aliases so the
 * emitted literals match what the kernel resolves.
 */
function ancestorMetadataAllowList(policy) {
    const seen = new Set();
    const add = (dir) => {
        if (dir.length === 0)
            return;
        seen.add(dir);
    };
    const boundaries = [policy.root, ...(policy.scratchDir ? [policy.scratchDir] : [])].map((p) => canonicalizeForPolicy(p));
    for (const boundary of boundaries) {
        // Stop before the boundary itself: it is already read-allowed and must not
        // be turned into a bare `literal` metadata allow that could be mistaken for
        // content access.
        let current = dirname(boundary);
        for (;;) {
            add(current);
            const parent = dirname(current);
            if (parent === current)
                break;
            current = parent;
        }
    }
    // Most general first (shortest path), so the output is stable and reviewable.
    return [...seen].sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
}
/**
 * Roots under which a sandboxed child may open a unix-domain socket.
 *
 * These are the *trusted* project and scratch trees only. The manager control
 * socket and every other service socket live outside both, so they remain
 * denied. Canonicalizing collapses `/var` <-> `/private/var` and refuses a
 * symlinked root, so the emitted `subpath` matches what the kernel resolves.
 */
function unixSocketAllowRoots(policy) {
    const roots = new Set();
    roots.add(canonicalizeForPolicy(policy.root));
    if (policy.scratchDir !== undefined) {
        roots.add(canonicalizeForPolicy(policy.scratchDir));
    }
    return [...roots];
}
/** Live process registry so the caller can abort a project's processes. */
export class ProcessTracker {
    #live = new Map();
    add(pid, child) {
        this.#live.set(pid, child);
    }
    remove(pid) {
        this.#live.delete(pid);
    }
    /** Kill every tracked process group; used by abortActiveProcesses(). */
    killAll() {
        for (const child of this.#live.values()) {
            killGroup(child, "SIGKILL");
        }
        this.#live.clear();
    }
    /**
     * Kill every tracked process group AND wait for each owned child to actually
     * exit (its `close`/`error`), bounded by `timeoutMs`. Returns `true` when all
     * owned groups drained within the bound, `false` if any is still alive.
     *
     * `killAll` only SIGNALS — it clears the registry immediately, so a
     * subsequent writer could still be flushing. The manager-pause finalizer uses
     * this to CONFIRM no owned bash group keeps writing before it records the
     * durable pause, rather than assuming the signal landed.
     */
    async killAllAndDrain(timeoutMs) {
        const children = [...this.#live.values()];
        this.#live.clear();
        if (children.length === 0)
            return true;
        const waits = children.map((child) => new Promise((resolve) => {
            let done = false;
            const finish = (drained) => {
                if (done)
                    return;
                done = true;
                clearTimeout(timer);
                resolve(drained);
            };
            const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
            timer.unref?.();
            child.once("close", () => finish(true));
            child.once("error", () => finish(true));
        }));
        for (const child of children)
            killGroup(child, "SIGKILL");
        const results = await Promise.all(waits);
        return results.every((drained) => drained);
    }
    /**
     * Kill every owned group and CONFIRM the registry stays empty for a short
     * quiet window, bounded by `timeoutMs`. A tool call that is still spinning up
     * its supervisor registers its child a moment after the first kill, so a
     * single {@link killAllAndDrain} can miss it. This re-drains until the
     * registry is continuously empty (no owned group is left writing), returning
     * `true` only when nothing is tracked for the whole quiet window.
     */
    async killAllAndDrainStable(timeoutMs) {
        const deadline = Date.now() + Math.max(0, timeoutMs);
        const quietWindowMs = 50;
        // First, give any tool call that has not yet spawned its supervisor a brief
        // moment to do so, so we kill the group rather than racing past it.
        await new Promise((resolve) => setTimeout(resolve, quietWindowMs));
        for (;;) {
            const remaining = deadline - Date.now();
            const drained = await this.killAllAndDrain(Math.max(0, remaining));
            if (this.#live.size === 0) {
                // Confirm nothing re-registered during a quiet window.
                await new Promise((resolve) => setTimeout(resolve, quietWindowMs));
                if (this.#live.size === 0)
                    return drained && Date.now() <= deadline;
            }
            if (Date.now() >= deadline)
                return false;
        }
    }
    get size() {
        return this.#live.size;
    }
}
/** How long to wait for the supervisor's READY frame before failing closed. */
const READY_TIMEOUT_MS = 10_000;
/** Largest single delay Node's `setTimeout` can represent (~24.85 days). */
const MAX_TIMER_MS = 2_147_483_647;
/**
 * Arm a timer for `policy.timeoutMs` and return a handle that clears it. The
 * value is config-validated to be at most `MAX_TIMER_MS`, so a native timer
 * never overflows to ~1ms. Must be a positive finite number.
 */
function scheduleLongTimeout(fn, delayMs) {
    const handle = setTimeout(fn, delayMs);
    handle.unref?.();
    return {
        clear() {
            clearTimeout(handle);
        },
    };
}
/** Clamp a wait bound to Node's timer range so it never overflows to ~1ms. */
function clampToTimerRange(value) {
    if (!Number.isFinite(value) || value <= 0)
        return 0;
    return Math.min(value, MAX_TIMER_MS);
}
/**
 * Resolve with the ACTUAL command's trusted exit status (from FD3), or a spawn
 * error. Returns `{code:null,signal:null}` when the transport dies without a
 * status frame (e.g. the daemon crashed) — callers must not invent a pass.
 */
async function waitForActualExit(status, timeoutMs) {
    const exit = await status.waitFor("exit", timeoutMs);
    if (exit !== undefined)
        return { code: exit.code, signal: exit.signal };
    const spawnErr = await status.waitFor("spawnerror", 0);
    if (spawnErr !== undefined)
        return { code: null, signal: null, spawnError: { code: spawnErr.code } };
    const bad = await status.waitFor("error", 0);
    void bad;
    return { code: null, signal: null };
}
/** Resolve once the child process has fully exited, or after `ms` (bounded). */
function waitForClose(child, ms) {
    if (child.exitCode !== null || child.signalCode !== null)
        return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            child.removeListener("close", done);
            resolve();
        }, ms);
        timer.unref?.();
        const done = () => {
            clearTimeout(timer);
            resolve();
        };
        child.once("close", done);
        child.once("error", done);
    });
}
/** Terminate a child's process group, escalating to SIGKILL on the group. */
function killGroup(child, signal) {
    const pid = child.pid;
    if (pid === undefined)
        return;
    try {
        // Negative pid targets the whole process group created with detached: true.
        process.kill(-pid, signal);
    }
    catch {
        try {
            child.kill(signal);
        }
        catch {
            /* already gone */
        }
    }
}
/**
 * The sandbox scratch root: the assigned scratch, or the project root when no
 * scratch was assigned. Never model supplied — the caller owns the policy.
 */
function scratchRoot(policy) {
    return policy.scratchDir ?? policy.root;
}
/** Private 0700 HOME directory inside the scratch tree. */
export function sandboxHome(policy) {
    return join(scratchRoot(policy), ".home");
}
/** Private 0700 TMPDIR directory inside the scratch tree. */
export function sandboxTmp(policy) {
    return join(scratchRoot(policy), ".tmp");
}
/** Private 0700 cache directory inside the scratch tree. */
export function sandboxCache(policy) {
    return join(scratchRoot(policy), ".cache");
}
/** Private 0700 XDG config directory inside the sandbox HOME. */
export function sandboxConfigHome(policy) {
    return join(sandboxHome(policy), ".config");
}
/** Directories the host must create (mode 0700) before a sandboxed command. */
export function sandboxLayoutDirs(policy) {
    return [
        scratchRoot(policy),
        sandboxHome(policy),
        sandboxTmp(policy),
        sandboxCache(policy),
        sandboxConfigHome(policy),
    ];
}
/**
 * Host-side preparation, run before spawning the command.
 *
 * Creates the scratch root and its `.home`, `.tmp`, and `.cache` children with
 * private (0700) permissions. The sandboxed child cannot mkdir these itself: the
 * profile only permits writes and the sandbox-exec launcher is applied before
 * the shell runs, so if the directories (and their parents) are missing the
 * child gets EPERM. Creating them on the host, with a mode the sandbox
 * preserves, is what makes TMPDIR/HOME/cache writes work. No credentials or
 * model-supplied paths are involved.
 */
export async function prepareScratchLayout(policy) {
    for (const dir of sandboxLayoutDirs(policy)) {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        // `mkdir` mode is masked by umask and does not tighten an existing dir, so
        // enforce 0700 explicitly on the directories that actually exist.
        await chmodQuietly(dir, 0o700);
    }
}
/** chmod, ignoring platforms/filesystems that reject it (best effort). */
async function chmodQuietly(path, mode) {
    await chmod(path, mode).catch(() => undefined);
}
/** Clean allowlist environment; never inherits credentials or provider keys. */
export function buildSandboxEnv(policy) {
    const home = sandboxHome(policy);
    const env = {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin",
        HOME: home,
        TMPDIR: sandboxTmp(policy),
        LANG: process.env.LANG ?? "en_US.UTF-8",
        LC_ALL: process.env.LC_ALL ?? "en_US.UTF-8",
        PWD: policy.root,
        SHELL: "/bin/zsh",
        TERM: "dumb",
        TZ: "UTC",
        NO_COLOR: "1",
        XDG_CACHE_HOME: sandboxCache(policy),
        XDG_CONFIG_HOME: sandboxConfigHome(policy),
    };
    return env;
}
/**
 * Run `command` through `/usr/bin/sandbox-exec <private-profile> /bin/zsh -f -c`.
 *
 * Fails closed when the launcher is missing or inoperable. The command runs in
 * its own process group (detached) so completion/abort/timeout kill the whole
 * tree, including background descendants. Output is bounded to the policy's
 * tail limit; the full output is written to a spill file when truncated.
 */
export async function runSandboxedCommand(policy, command, options = {}) {
    const cwd = options.cwd ?? policy.root;
    if (!isWithin(policy.root, cwd)) {
        throw new ToolError("outside_root", `cwd escapes project root: ${cwd}`);
    }
    const started = Date.now();
    // An already-aborted signal must never execute the command at all.
    const signal = options.signal ?? options.hooks?.getAbortSignal?.();
    if (signal?.aborted) {
        throw new ToolError("aborted", "command aborted before start");
    }
    let profile = "";
    if (!options.unsandboxedForTesting) {
        await assertSandboxAvailable(policy);
        profile = buildSandboxProfile(policy);
    }
    // Host-side layout: the child cannot create TMPDIR/HOME/cache itself (writes
    // are confined and sandbox-exec is applied before the shell starts), so the
    // host pre-creates the scratch tree with private 0700 modes. This is a trusted
    // path from the policy; nothing here is model supplied.
    await prepareScratchLayout(policy);
    const env = buildSandboxEnv(policy);
    // The ACTUAL command: sandbox-exec with the profile (production) or the bare
    // shell (test seam). It is deliberately NOT run directly by us — the
    // standalone command-supervisor runs it in its own process group AFTER it has
    // reported READY and we have persisted the process receipt and sent START.
    const actualProgram = options.unsandboxedForTesting ? "/bin/zsh" : policy.sandboxExec;
    const actualArgs = options.unsandboxedForTesting
        ? ["-f", "-c", command]
        : ["-p", profile, "/bin/zsh", "-f", "-c", command];
    // Real bounded retention: each stream keeps at most `maxBytes` of trailing
    // data in memory. The full combined stream is written to a private scratch
    // artifact as it arrives, so nothing is silently discarded and nothing is
    // accumulated unbounded in memory.
    const maxBytes = policy.maxOutputBytes;
    const stdoutTail = new TailBuffer(maxBytes);
    const stderrTail = new TailBuffer(maxBytes);
    const spillPath = join(scratchFor(policy), `.bash-output-${Date.now()}-${process.pid}.log`);
    const sink = await openPrivateSink(spillPath);
    let totalBytes = 0;
    let timedOut = false;
    // Resolve the adjacent COMPILED supervisor module. It works unmodified for
    // both `dist/src/sandbox.js` and `dist-test/src/sandbox.js` because the
    // supervisor is emitted as a sibling by the same tsc invocation.
    const supervisorPath = fileURLToPath(new URL("./command-supervisor.js", import.meta.url));
    let child;
    try {
        child = spawn(process.execPath, [supervisorPath, "--grace-ms", "500", "--", actualProgram, ...actualArgs], {
            cwd,
            env,
            detached: true,
            // FD0 control, FD1/FD2 child stdout/stderr, FD3 private status channel.
            stdio: ["pipe", "pipe", "pipe", "pipe"],
        });
    }
    catch (error) {
        // `spawn` can throw synchronously (e.g. ENOENT on the launcher). Clean up
        // the scratch sink and report a structured spawn error.
        await sink.close().catch(() => undefined);
        await removeQuietly(spillPath);
        throw new ToolError("spawn_error", error.message);
    }
    const tracker = options.tracker;
    if (child.pid !== undefined)
        tracker?.add(child.pid, child);
    const group = child.pid;
    const status = attachStatusChannel(child);
    // Fail closed on any protocol error: kill the OWNED watcher group and throw.
    const protocolFail = async (reason) => {
        status.dispose();
        killWatcherGroup(child, "SIGKILL");
        if (child.pid !== undefined)
            tracker?.remove(child.pid);
        await sink.close().catch(() => undefined);
        await removeQuietly(spillPath);
        throw new SupervisorProtocolError(reason);
    };
    // 1) READY must be version 1 and its pid/pgid must EXACTLY match the spawned
    //    watcher child pid; a mismatch is a protocol error (kill + throw).
    const ready = await status.waitFor("ready", READY_TIMEOUT_MS);
    if (ready === undefined) {
        await protocolFail("command supervisor did not report READY");
    }
    if (ready.version !== SUPERVISOR_VERSION) {
        await protocolFail(`unsupported supervisor version ${String(ready.version)}`);
    }
    if (ready.pid !== child.pid || ready.pgid !== child.pid) {
        await protocolFail(`supervisor reported foreign pid/pgid (${ready.pid}/${ready.pgid})`);
    }
    // 2) Persist the process receipt (onProcess "started") BEFORE sending START so
    //    no command side effect can precede durability. A throwing hook must not
    //    leak a live group or artifact.
    let startedHookRan = false;
    try {
        await options.hooks?.onProcess?.({ pid: child.pid, group, state: "started", command });
        startedHookRan = true;
    }
    catch (error) {
        status.dispose();
        killWatcherGroup(child, "SIGKILL");
        if (child.pid !== undefined)
            tracker?.remove(child.pid);
        await sink.close().catch(() => undefined);
        await removeQuietly(spillPath);
        throw new ToolError("spawn_error", `onProcess(started) failed: ${error.message}`);
    }
    // 3) Release the START barrier. The command runs only now.
    let stdinClosed = false;
    const closeStdin = () => {
        if (stdinClosed)
            return;
        stdinClosed = true;
        try {
            child.stdin?.end();
        }
        catch { /* already gone */ }
    };
    // The control pipe (FD0) is the START/STOP channel. Writing "START\n" after
    // the supervisor died — e.g. the parent kills it during the READY / receipt /
    // START window — surfaces as an ASYNCHRONOUS `'error'` (EPIPE) EventEmitter
    // event, NOT a synchronous throw, so `try { write() } catch {}` cannot catch
    // it and the process would crash with an uncaughtException. Attach a
    // TRUTHFUL handler that records the failure (fail-closed) instead of a bare
    // no-op: the flag is checked below so a control error can never be silently
    // swallowed and leave the caller waiting forever.
    let controlError;
    const recordControlError = (error) => {
        if (controlError === undefined)
            controlError = error;
    };
    child.stdin?.on("error", recordControlError);
    // Release the START barrier. Both the synchronous throw (write before the
    // stream is ready) and the write-callback error are captured; the async
    // `'error'` event is handled by the listener above.
    try {
        child.stdin?.write("START\n", (error) => {
            if (error)
                recordControlError(error);
        });
    }
    catch (error) {
        await protocolFail(`failed to release START barrier: ${error.message}`);
    }
    // Give any pending control-pipe error a chance to be delivered before we
    // record the receipt as durable, so a killed supervisor is reported as a
    // structured protocol failure rather than a live command.
    if (controlError === undefined)
        await new Promise((resolve) => setImmediate(resolve));
    if (controlError !== undefined) {
        await protocolFail(`control pipe failed before START: ${controlError.message}`);
    }
    // Bookkeeping stream: write every chunk to the private artifact while keeping
    // only a bounded tail in memory. `collect` is the single data path. The sink
    // serializes its own writes, so no unbounded promise array is retained.
    const collect = (chunk, sinkKind) => {
        totalBytes += chunk.length;
        (sinkKind === "out" ? stdoutTail : stderrTail).push(chunk);
        void sink.write(chunk);
    };
    child.stdout?.on("data", (chunk) => collect(chunk, "out"));
    child.stderr?.on("data", (chunk) => collect(chunk, "err"));
    // Cleanup path: killing the watcher group + closing its control pipe makes the
    // watcher SIGTERM/SIGKILL everything in its group. Its transport death is NOT
    // the actual command status.
    const abortCleanup = () => {
        closeStdin();
        killWatcherGroup(child, "SIGTERM");
        const t = setTimeout(() => killWatcherGroup(child, "SIGKILL"), 2000);
        t.unref?.();
    };
    // The abort cleanup path is shared by timeout and external abort. When the
    // policy timeout is null (UNLIMITED) we NEVER arm a timer: no setTimeout(null/
    // Infinity/NaN) is possible, and no overflow/binding warning is emitted. A
    // finite value beyond Node's 32-bit timer range is chunked, never collapsed
    // to ~1ms.
    const timeout = policy.timeoutMs === null
        ? undefined
        : scheduleLongTimeout(() => {
            timedOut = true;
            abortCleanup();
        }, policy.timeoutMs);
    const abortHandler = () => abortCleanup();
    if (signal)
        signal.addEventListener("abort", abortHandler, { once: true });
    // 4) Trust ONLY the FD3 status frames for the actual command result. The
    //    wait bound is the (optional) command timeout plus a BOUNDED READY
    //    allowance; when the command is unlimited we still bound the wait by an
    //    EXTERNAL event — the transport closing (status channel resolves on
    //    close) — so we never block forever on a dead watcher. NOTE: the bound
    //    below is a liveness check on the STATUS CHANNEL, not a command cap, and
    //    is clamped to Node's timer range so a long cap never overflows to ~1ms.
    const exit = policy.timeoutMs === null
        ? await waitForActualExit(status, null)
        : await waitForActualExit(status, clampToTimerRange(policy.timeoutMs + READY_TIMEOUT_MS));
    const spawnErrorInfo = exit.spawnError;
    timeout?.clear();
    signal?.removeEventListener("abort", abortHandler);
    // 5) Force cleanup and JOIN the whole watcher group BEFORE stopped/onCommand/
    //    lease-free. Closing FD0 makes the watcher stop its own group; we then
    //    SIGKILL the WHOLE group and CONFIRM it is gone. If we cannot confirm the
    //    group is dead we FAIL CLOSED (no stopped hook, no result) so the caller
    //    retains the lease rather than freeing it behind a live external command.
    closeStdin();
    const groupGone = await waitForWatcherGroupGone(child, 3000);
    await waitForClose(child, 3000);
    status.dispose();
    if (child.pid !== undefined)
        tracker?.remove(child.pid);
    if (!groupGone) {
        // Leave the stopped hook unwritten: the row must stay in-doubt for review.
        await sink.close().catch(() => undefined);
        await removeQuietly(spillPath).catch(() => undefined);
        throw new ToolError("spawn_error", `command process group ${group ?? child.pid} did not fully exit; refusing to report a clean result`);
    }
    if (startedHookRan) {
        try {
            await options.hooks?.onProcess?.({ pid: child.pid, group, state: "stopped", command });
        }
        catch {
            /* a failing stop hook must not lose the command result */
        }
    }
    await sink.close().catch(() => undefined);
    const overflow = totalBytes > maxBytes;
    const aborted = signal?.aborted ?? false;
    const failed = timedOut || (aborted && !timedOut);
    // Keep the artifact only when the inline tail was truncated AND the command
    // completed; a timeout/abort cleans up its artifact so nothing is retained.
    let fullOutputPath = null;
    if (overflow && !failed) {
        fullOutputPath = spillPath;
    }
    else {
        await removeQuietly(spillPath);
    }
    const result = {
        command,
        cwd,
        stdout: stdoutTail.toString(),
        stderr: stderrTail.toString(),
        // Trusted status: FD3 exit code/signal, or a spawn error (ENOENT => 127).
        exitCode: spawnErrorInfo !== undefined
            ? spawnErrorInfo.code
            : (exit.code ?? (exit.signal ? 128 : -1)),
        signal: spawnErrorInfo !== undefined ? null : exit.signal,
        timedOut,
        truncated: overflow,
        totalBytes,
        fullOutputPath,
        durationMs: Date.now() - started,
    };
    // Exactly one onCommand call per command, covering nonzero exit and
    // timeout/abort as well. A throwing hook is reported, not silently swallowed,
    // but must not corrupt the process/hook cleanup already performed above.
    try {
        await options.hooks?.onCommand?.(result);
    }
    catch (error) {
        throw new ToolError("spawn_error", `onCommand hook failed: ${error.message}`);
    }
    if (aborted && !timedOut) {
        throw new ToolError("aborted", "command aborted");
    }
    if (timedOut) {
        throw new ToolError("timeout", `command timed out after ${policy.timeoutMs}ms`);
    }
    return result;
}
/**
 * A bounded trailing byte buffer: retains at most `limit` bytes, discarding the
 * oldest data as new data arrives. Memory use is O(limit), independent of how
 * much output the command produces.
 */
class TailBuffer {
    #limit;
    #chunks = [];
    #size = 0;
    constructor(limit) {
        this.#limit = Math.max(0, limit);
    }
    push(chunk) {
        if (this.#limit === 0)
            return;
        this.#chunks.push(chunk);
        this.#size += chunk.length;
        while (this.#size > this.#limit && this.#chunks.length > 0) {
            const head = this.#chunks[0];
            const excess = this.#size - this.#limit;
            if (head.length <= excess) {
                this.#chunks.shift();
                this.#size -= head.length;
            }
            else {
                this.#chunks[0] = head.subarray(excess);
                this.#size -= excess;
            }
        }
    }
    toString() {
        return Buffer.concat(this.#chunks).toString("utf8");
    }
}
/** Scratch tree used for spill artifacts; falls back to the project root. */
function scratchFor(policy) {
    return policy.scratchDir ?? policy.root;
}
/** Open a private (0600) append sink, creating parent dirs as needed. */
async function openPrivateSink(path) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(path, "w", 0o600);
    let chain = Promise.resolve();
    return {
        write(chunk) {
            chain = chain.then(() => handle.write(chunk).then(() => undefined));
            return chain;
        },
        async close() {
            await chain.catch(() => undefined);
            await handle.close();
        },
    };
}
/** Remove a file, ignoring ENOENT and other races. */
async function removeQuietly(path) {
    await rm(path, { force: true }).catch(() => undefined);
}
/** Fail-closed check that sandbox-exec exists, is executable, and can start. */
async function assertSandboxAvailable(policy) {
    if (process.platform !== "darwin") {
        throw new ToolError("sandbox_unavailable", "sandbox-exec is only available on macOS");
    }
    const info = await lstatOrUndefined(policy.sandboxExec);
    if (info === undefined) {
        throw new ToolError("sandbox_unavailable", `sandbox launcher missing: ${policy.sandboxExec}`);
    }
    const capable = await canApplyProfile(policy);
    if (!capable) {
        throw new ToolError("sandbox_unavailable", "sandbox-exec cannot apply a profile in this environment (nested sandbox?)");
    }
    // The capability probe only proves sandbox-exec can start. Also verify the
    // ACTUAL production profile applies; a malformed/over-restrictive profile must
    // fail closed rather than silently running unsandboxed.
    const policyOk = await canApplyPolicyProfile(policy);
    if (!policyOk) {
        throw new ToolError("sandbox_unavailable", "sandbox-exec could not apply the project profile (invalid SBPL or blocked launcher)");
    }
}
/**
 * Probe whether the launcher can apply *any* profile. Uses a harmless
 * `(version 1)(allow default)` profile so the probe result reflects launcher
 * capability only — never the policy under test. Cached per launcher path, so
 * distinct launchers (e.g. a test override) are probed independently.
 */
const capabilityCache = new Map();
export async function canApplyProfile(policy) {
    const launcher = policy.sandboxExec;
    const cached = capabilityCache.get(launcher);
    if (cached !== undefined)
        return cached;
    const probe = probeLauncher(launcher, "(version 1)(allow default)");
    capabilityCache.set(launcher, probe);
    return probe;
}
/**
 * Apply the ACTUAL built policy profile to a harmless command. Returns false if
 * the profile is rejected (invalid SBPL) or the launcher cannot run it; callers
 * treat that as `sandbox_unavailable` (fail closed). This is intentionally a
 * separate probe from {@link canApplyProfile}: a working capability probe must
 * not mask a broken production profile.
 */
export async function canApplyPolicyProfile(policy) {
    const profile = buildSandboxProfile(policy);
    return probeLauncher(policy.sandboxExec, profile);
}
/** Run `<launcher> -p <profile> /usr/bin/true` and report whether it exits 0. */
function probeLauncher(launcher, profile) {
    return new Promise((resolvePromise) => {
        let child;
        try {
            child = spawn(launcher, ["-p", profile, "/usr/bin/true"], { stdio: "ignore" });
        }
        catch {
            resolvePromise(false);
            return;
        }
        const t = setTimeout(() => {
            killGroup(child, "SIGKILL");
            resolvePromise(false);
        }, 5000);
        child.on("close", (code) => {
            clearTimeout(t);
            resolvePromise(code === 0);
        });
        child.on("error", () => {
            clearTimeout(t);
            resolvePromise(false);
        });
    });
}
/** Reset the launcher capability cache; for tests. */
export function resetSandboxProbe() {
    capabilityCache.clear();
}
//# sourceMappingURL=sandbox.js.map