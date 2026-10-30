/**
 * `pi-durable check` — an honest end-to-end self-check for the beta.
 *
 * Two modes:
 *   * OFFLINE (default; `--offline`): everything runs inside ONE fresh temp
 *     directory with a dummy credential reference and a real, isolated local
 *     service started on a loopback socket. The inference is a deterministic
 *     LOCAL FIXTURE — every such result is explicitly labelled `fixture`. It
 *     never touches production state, never reads a real key, and removes only
 *     the temp directory it created (verified to be under the OS temp dir).
 *   * ONLINE (`--online`): uses a real config + endpoint for a genuine
 *     inference/wake cycle. It REQUIRES a user-requested thread UUID and never
 *     fabricates a successful dispatch or ack.
 *
 * Every step reports `PASS`, `FAIL`, or `SKIP` with a truthful detail string.
 * The command exits non-zero iff any step FAILs.
 */
import { type SetupDeps } from "./setup.js";
import { defaultSetupDeps } from "./cli-setup.js";
/** The verdict of a single check step. */
export type CheckStatus = "PASS" | "FAIL" | "SKIP" | "PENDING";
/** One reported step. */
export interface CheckStep {
    readonly id: string;
    readonly label: string;
    readonly status: CheckStatus;
    readonly detail: string;
    /** True when this step exercised the deterministic local fixture provider. */
    readonly fixture?: boolean;
}
/** The complete check report. */
export interface CheckReport {
    readonly version: string;
    readonly mode: "offline" | "online";
    readonly ok: boolean;
    readonly steps: readonly CheckStep[];
    /** Temp workspace used (offline mode only); already cleaned up on success. */
    readonly workspace?: string;
    readonly threadId?: string;
    /** Online run record with all ids (project/session/assignment/request/event). */
    readonly runFile?: string;
}
/** Aggregate results into a report; `ok` is false iff any step FAILed. */
export declare function summarize(version: string, mode: "offline" | "online", steps: readonly CheckStep[], extra?: {
    workspace?: string;
    threadId?: string;
    runFile?: string;
}): CheckReport;
/** Render a report for humans. */
export declare function renderCheck(report: CheckReport): string;
/**
 * Create a verified temporary workspace. Uses `mkdtemp` under the OS temp dir
 * and refuses to return a path outside it, so a later cleanup can never touch
 * anything the check did not itself create.
 */
export declare function makeWorkspace(prefix?: string): string;
/**
 * True iff `child` is strictly inside `root` (canonical, boundary-aware). Uses
 * `path.relative` so there is no directory-PREFIX bug: `/tmp/foo` never matches
 * `/tmp/foobar`. Both sides are canonicalized first so a symlinked OS temp dir
 * (`/var` → `/private/var`) compares like-for-like.
 */
export declare function isStrictlyInside(child: string, root: string): boolean;
/** A fixed, valid v4-shaped UUID used as the offline manager thread id. */
export declare const FIXTURE_THREAD_ID = "00000000-0000-4000-8000-0000000000f1";
/**
 * Pick a base directory for the isolated service's runtime (UNIX domain socket)
 * that is both writable and short enough for the socket-path limit.
 *
 * Preference order:
 *  1. A `PI_DURABLE_RUNTIME_DIR` the caller already exported.
 *  2. `/tmp` (the normal macOS location; short and world-writable-parent).
 *  3. A short, process-local fallback directory next to the checkout/install
 *     (`<cwd>/.pi-durable-runtime`) for sandboxes whose `/tmp` is not writable.
 *
 * Returns `undefined` when no candidate yields a path within the UDS limit, so
 * the caller can honestly SKIP the service steps instead of failing a healthy
 * machine.
 */
export declare function chooseRuntimeDir(cwd?: string): string | undefined;
/** Build a fixture config object (schema v1) for the isolated offline run. */
export declare function fixtureConfig(workspace: string, options?: {
    endpoint?: string;
    cliExecutable?: string;
    cliBaseArgs?: readonly string[];
}): Record<string, unknown>;
/** SHA-256 hex of a UTF-8 string (used to hash evidence bytes in the check). */
export declare function sha256Hex(text: string): string;
/**
 * Locate the shipped `scripts/` directory that contains the standalone
 * installers. Compiled output may run from `dist/` (production) or
 * `dist-test/src/` (tests), so walk up until we find a `scripts/install-skill.mjs`
 * next to a `bin/pi-durable.js`. Throws if none is found (a packaging bug).
 */
export declare function findScriptsDir(startDir: string): string;
/** A resolved service socket plus the env/short-dir needed to host it. */
export interface ServiceSocket {
    /** Absolute socket path to hand to `serve --socket`. */
    readonly socketPath: string;
    /** Extra child env (e.g. `PI_DURABLE_RUNTIME_DIR`); never a real secret. */
    readonly env: Record<string, string>;
    /** Short dir under cwd used only when no runtime base is writable (cleanup). */
    readonly shortSocketDir?: string;
    /** False when even the shortest base cannot fit the platform UDS limit. */
    readonly canStart: boolean;
}
/**
 * Resolve a service socket the SAME way for offline and online runs: prefer a
 * short runtime base (honouring `PI_DURABLE_RUNTIME_DIR`), else fall back to a
 * short private dir under the working directory. This keeps the online path's
 * behavior identical to the isolated check and to the real CLI, and it lets a
 * sandbox whose `/tmp` is not user-owned still host the service.
 */
export declare function resolveServiceSocket(stateDir: string, cwd?: string): ServiceSocket;
/**
 * The real supported `codex queue` usage banner. Mirrors the host CLI exactly
 * (`Usage: codex queue [OPTIONS] --thread <THREAD> --message <TEXT>`) so a
 * `--help` probe against the fixture stub reports the true flag surface rather
 * than inventing one.
 */
export declare const FIXTURE_QUEUE_HELP = "Usage: codex queue [OPTIONS] --thread <THREAD> --message <TEXT>\n";
/**
 * Write an owned stub `codex` CLI that captures its argv to a file and exits 0.
 *
 * IMPORTANT: the native manager transport is ARGV-ONLY. The dispatcher spawns
 * this via `execFile` with a stdin PIPE that it never closes, so the stub MUST
 * NOT read stdin — a synchronous `fs.readFileSync(0, ...)` would block until
 * EOF that never comes, wedging the dispatcher (the original deadlock).
 *
 * Behaviour:
 *  - `--help` / `-h` / bare `help`: print the REAL queue usage banner (no
 *    capture), so a version/help probe is answered truthfully and never
 *    mistaken for a wake delivery.
 *  - `--version` / `-V`: print a version string (no capture).
 *  - any other invocation: append `{ argv, at }` to the capture file.
 *
 * Used ONLY by the offline fixture so the wake dispatcher is exercised
 * end-to-end without a real Codex install. Returns the executable path.
 */
export declare function writeFixtureWakeStub(dir: string, capturePath: string): string;
/** Options for the offline check. */
export interface OfflineCheckOptions {
    readonly deps: SetupDeps;
    /** Absolute path to the CLI bin used to spawn the isolated service. */
    readonly binPath: string;
    /** Sink for progress lines (stderr-safe; keeps stdout to one envelope). */
    readonly log?: (line: string) => void;
}
/**
 * Run the offline, isolated end-to-end check.
 *
 * Steps exercise: packaged setup → dummy credential reference → real isolated
 * service → project/session create → sandboxed tool playback (fixture) →
 * evidence/accept → reconnect → stale-event idempotency → secret redaction →
 * cleanup ownership. All paths include a space to prove space-safety.
 */
export declare function runOfflineCheck(options: OfflineCheckOptions): Promise<CheckReport>;
export interface ServiceIdentity {
    configFile?: string | null;
    stateDir?: string;
    protocolVersion?: number;
    packageVersion?: string;
    model?: string;
    providerId?: string;
}
/**
 * The FULL service-identity comparison the online check performs BEFORE any
 * project mutation. Every field is validated STRICTLY: a missing field is a
 * mismatch, never "unknown so probably fine". Returns the individual booleans,
 * the aggregate `compatible`, and human reasons for any mismatch so the caller
 * can report truthfully and stop before mutating.
 */
export declare function serviceCompatCheck(status: ServiceIdentity | undefined | null, expected: {
    configPath: string;
    stateDir: string;
    packageVersion: string;
    model: string | undefined;
    providerId?: string;
}): {
    compatible: boolean;
    sameConfig: boolean;
    sameState: boolean;
    sameProtocol: boolean;
    samePackageVersion: boolean;
    sameProvider: boolean;
    sameModel: boolean;
    reasons: string[];
};
/** Options for the online check (real endpoint + wake). */
export interface OnlineCheckOptions {
    readonly deps: SetupDeps;
    /** Absolute path to the CLI bin. */
    readonly binPath: string;
    readonly configPath: string;
    /** User-requested Codex thread UUID that will own the wake receipt. */
    readonly threadId: string;
    /**
     * Optional absolute path where the run record (ids for project/session/
     * assignment/request/event/receipt) is persisted BEFORE this function
     * returns. Defaults to `<stateDir>/online-check-runs/<runId>.json`.
     */
    readonly runFile?: string;
    /** Bounded window to wait for the first wake event after submit (default 30s). */
    readonly eventWaitMs?: number;
    /**
     * Injectable filesystem for the run receipt (defaults to the real atomic
     * 0600 writer). Tests override this to prove that a receipt that cannot be
     * durably persisted is FATAL before ANY mutation — nothing is submitted.
     */
    readonly runFs?: RunStoreFs;
    readonly log?: (line: string) => void;
}
/**
 * Run the online check against a REAL endpoint. Requires an explicit thread
 * UUID; it never invents one and never reports a fabricated dispatch/ack.
 *
 * NOTE: This function performs real inference/wake. It is intended to be
 * invoked by a human or the manager, not by automated CI (which must use
 * `--offline`). It does not run other LLM coding workers itself.
 */
export declare function runOnlineCheck(options: OnlineCheckOptions): Promise<CheckReport>;
/**
 * Raised when the run record cannot be durably persisted.
 *
 * The record is the ONLY durable evidence that a run happened — it carries the
 * project/session/assignment/request ids used to reconcile a crash or a lost
 * transport reply. If it cannot be written, the check must FAIL loudly (never
 * report PASS) and, before any mutation, submit NOTHING.
 */
export declare class RunPersistError extends Error {
    readonly code = "run_record_persist_failed";
    constructor(message: string);
}
/**
 * Persist an online-check run record privately (0600) and atomically.
 *
 * Throws {@link RunPersistError} if the record cannot be written or renamed into
 * place. Callers decide whether that is fatal: before the FIRST mutation it is
 * FATAL (submit nothing); after a durable submit it is reported truthfully with
 * the already-recorded ids (never silently swallowed, never re-submitted).
 */
export interface RunStoreFs {
    /** Create the run directory (recursively) with private permissions. */
    readonly mkdir: (dir: string, mode: number) => Promise<void>;
    /** Write the temp file with the final permission bits. */
    readonly write: (file: string, data: string, mode: number) => Promise<void>;
    /** Atomically rename the temp file into place. */
    readonly rename: (from: string, to: string) => Promise<void>;
}
/** The real filesystem used to persist run receipts (atomic, 0600). */
export declare const realRunStoreFs: RunStoreFs;
/** Options for `pi-durable check --verify <runId>`. */
export interface OnlineVerifyOptions {
    readonly runId: string;
    readonly configPath: string;
    readonly binPath: string;
    /** Directory holding run records; default `<stateDir>/online-check-runs`. */
    readonly runDir?: string;
    readonly log?: (line: string) => void;
}
/**
 * Compute the final verify verdict. PASS requires ALL of:
 *   - the assignment state is `accepted`;
 *   - the relevant manager event was DELIVERED;
 *   - that event is ACKED.
 * Running/queued/needs_review/revision_requested (or a delivered-but-unacked
 * event) => PENDING. failed/unanswered/budget/timeout/cancelled or an unknown/
 * missing id/state => FAIL.
 */
export declare function verifyVerdict(input: {
    assignmentState: string | undefined;
    eventDelivered: boolean;
    eventAcked: boolean;
    eventListed: boolean;
    assignmentId: string | undefined;
    projectId: string | undefined;
}): {
    status: CheckStatus;
    detail: string;
};
/**
 * Re-open a previously persisted online run and report its CURRENT state:
 * the assignment state, whether it was reviewed/acked. Never auto-accepts or
 * auto-acks; it only READS and reports. This is the "resume/verify receipt"
 * command the online check points you at after you have reviewed the output.
 */
export declare function verifyOnlineCheck(options: OnlineVerifyOptions): Promise<CheckReport>;
export { defaultSetupDeps };
//# sourceMappingURL=check.d.ts.map