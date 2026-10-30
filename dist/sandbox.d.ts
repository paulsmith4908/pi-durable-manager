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
import { type ChildProcess } from "node:child_process";
import { lstat } from "node:fs/promises";
/** Absolute path to the macOS sandbox launcher. */
export declare const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** Protected file/directory names that are never read or written through tools. */
export declare const PROTECTED_NAMES: readonly [".git", ".secrets", ".runtime", "config.local.json"];
/** Structured, model-visible error codes returned instead of throwing to the service. */
export type ToolErrorCode = "outside_root" | "protected_path" | "not_found" | "not_a_file" | "is_directory" | "ambiguous_match" | "no_match" | "too_large" | "invalid_argument" | "sandbox_unavailable" | "spawn_error" | "timeout" | "aborted";
/** Error carrying a machine-readable code; tools convert it to a model-visible result. */
export declare class ToolError extends Error {
    readonly code: ToolErrorCode;
    constructor(code: ToolErrorCode, message: string);
}
/** Per-project tool options. `root` is canonical; it is the only writable tree. */
export interface ToolPolicy {
    /** Canonical absolute project root; the tool boundary. */
    readonly root: string;
    /** Additional read/write-blocked paths (state dir, config file, key files). */
    readonly protectedPaths?: readonly string[];
    /** Isolated per-assignment scratch directory (writable and readable). */
    readonly scratchDir?: string;
    /** Absolute path to sandbox-exec; overridable for tests, fail-closed if missing. */
    readonly sandboxExec?: string;
    /** Allow network in the sandbox for a command. Default false. */
    readonly allowNetwork?: boolean;
    /**
     * Optional HARD command-timeout cap in ms. Omitted or `null` (the default)
     * means UNLIMITED: a long-running foreground command may run for hours. A
     * positive finite value caps every command; a per-call `timeout` may request
     * a SHORTER limit but can never exceed this cap.
     */
    readonly timeoutMs?: number | null;
    /** Max retained output bytes for bash tail. Default 200000. */
    readonly maxOutputBytes?: number;
}
/** Normalized policy with defaults resolved. */
export interface ResolvedToolPolicy {
    readonly root: string;
    readonly protectedPaths: readonly string[];
    readonly scratchDir?: string;
    readonly sandboxExec: string;
    readonly allowNetwork: boolean;
    /** Hard command-timeout cap in ms; `null` = unlimited. */
    readonly timeoutMs: number | null;
    readonly maxOutputBytes: number;
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
export declare function resolvePolicy(policy: ToolPolicy): ResolvedToolPolicy;
/** True when `child` equals `parent` or is inside it (lexical, resolved). */
export declare function isWithin(parent: string, child: string): boolean;
/**
 * Validate a model-supplied path against the project boundary and return the
 * canonical absolute path.
 *
 * Rejects: non-absolute root reuse, `..` traversal, symlink target outside the
 * root, symlink in a parent component outside the root, and protected paths.
 * For writes, the target need not exist; the nearest existing ancestor is
 * canonicalized so a symlinked parent cannot escape.
 */
export declare function resolveWithinRoot(policy: ResolvedToolPolicy, inputPath: string, mode: "read" | "write"): Promise<string>;
/**
 * Final-component safety check: if the target exists and is a symlink, reject
 * (callers use O_NOFOLLOW where possible). Returns lstat info or undefined.
 */
export declare function lstatOrUndefined(absPath: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined>;
/** Open flags that refuse to follow a final symlink. */
export declare const O_NOFOLLOW: number;
/**
 * Write `content` to `absPath` without following a final symlink (O_NOFOLLOW),
 * creating the file with private (0600) mode. `O_CREAT | O_TRUNC | O_WRONLY`.
 * A final-component symlink is refused (ELOOP) rather than followed.
 */
export declare function writeFileNoFollow(absPath: string, content: string): Promise<void>;
/** Open a file for reading without following a final symlink, returning its bytes. */
export declare function readFileNoFollow(absPath: string, maxBytes: number): Promise<Buffer>;
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
export declare function buildSandboxProfile(policy: ResolvedToolPolicy): string;
/** A concise report of a finished command. */
export interface CommandResult {
    readonly command: string;
    readonly cwd: string;
    /** Retained tail of stdout (bounded by `maxOutputBytes`). */
    readonly stdout: string;
    /** Retained tail of stderr (bounded by `maxOutputBytes`). */
    readonly stderr: string;
    readonly exitCode: number;
    readonly signal: string | null;
    readonly timedOut: boolean;
    /** True when combined output exceeded the retained limit. */
    readonly truncated: boolean;
    /** Total bytes observed across stdout and stderr (unbounded counter only). */
    readonly totalBytes: number;
    /**
     * Path to the full combined-stream artifact in scratch, written only when the
     * output was truncated (private mode 0600). `null` when output fit inline.
     */
    readonly fullOutputPath: string | null;
    readonly durationMs: number;
}
/** Hooks the assignment engine uses for metadata/evidence/restart. */
export interface ProcessHooks {
    onCommand?(result: CommandResult): void | Promise<void>;
    onProcess?(event: {
        readonly pid: number | undefined;
        readonly group: number | undefined;
        readonly state: "started" | "stopped";
        readonly command: string;
    }): void | Promise<void>;
    getAbortSignal?(): AbortSignal | undefined;
}
/** Live process registry so the caller can abort a project's processes. */
export declare class ProcessTracker {
    #private;
    add(pid: number, child: ChildProcess): void;
    remove(pid: number): void;
    /** Kill every tracked process group; used by abortActiveProcesses(). */
    killAll(): void;
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
    killAllAndDrain(timeoutMs: number): Promise<boolean>;
    /**
     * Kill every owned group and CONFIRM the registry stays empty for a short
     * quiet window, bounded by `timeoutMs`. A tool call that is still spinning up
     * its supervisor registers its child a moment after the first kill, so a
     * single {@link killAllAndDrain} can miss it. This re-drains until the
     * registry is continuously empty (no owned group is left writing), returning
     * `true` only when nothing is tracked for the whole quiet window.
     */
    killAllAndDrainStable(timeoutMs: number): Promise<boolean>;
    get size(): number;
}
/** Private 0700 HOME directory inside the scratch tree. */
export declare function sandboxHome(policy: ResolvedToolPolicy): string;
/** Private 0700 TMPDIR directory inside the scratch tree. */
export declare function sandboxTmp(policy: ResolvedToolPolicy): string;
/** Private 0700 cache directory inside the scratch tree. */
export declare function sandboxCache(policy: ResolvedToolPolicy): string;
/** Private 0700 XDG config directory inside the sandbox HOME. */
export declare function sandboxConfigHome(policy: ResolvedToolPolicy): string;
/** Directories the host must create (mode 0700) before a sandboxed command. */
export declare function sandboxLayoutDirs(policy: ResolvedToolPolicy): string[];
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
export declare function prepareScratchLayout(policy: ResolvedToolPolicy): Promise<void>;
/** Clean allowlist environment; never inherits credentials or provider keys. */
export declare function buildSandboxEnv(policy: ResolvedToolPolicy): Record<string, string>;
/**
 * Run `command` through `/usr/bin/sandbox-exec <private-profile> /bin/zsh -f -c`.
 *
 * Fails closed when the launcher is missing or inoperable. The command runs in
 * its own process group (detached) so completion/abort/timeout kill the whole
 * tree, including background descendants. Output is bounded to the policy's
 * tail limit; the full output is written to a spill file when truncated.
 */
export declare function runSandboxedCommand(policy: ResolvedToolPolicy, command: string, options?: {
    readonly cwd?: string;
    readonly signal?: AbortSignal;
    readonly hooks?: ProcessHooks;
    readonly tracker?: ProcessTracker;
    /** Test seam: skip sandbox-exec and run the shell directly. Never set in production. */
    readonly unsandboxedForTesting?: boolean;
}): Promise<CommandResult>;
export declare function canApplyProfile(policy: ResolvedToolPolicy): Promise<boolean>;
/**
 * Apply the ACTUAL built policy profile to a harmless command. Returns false if
 * the profile is rejected (invalid SBPL) or the launcher cannot run it; callers
 * treat that as `sandbox_unavailable` (fail closed). This is intentionally a
 * separate probe from {@link canApplyProfile}: a working capability probe must
 * not mask a broken production profile.
 */
export declare function canApplyPolicyProfile(policy: ResolvedToolPolicy): Promise<boolean>;
/** Reset the launcher capability cache; for tests. */
export declare function resetSandboxProbe(): void;
//# sourceMappingURL=sandbox.d.ts.map