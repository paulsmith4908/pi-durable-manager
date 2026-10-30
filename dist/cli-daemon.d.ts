/**
 * Detached daemon lifecycle for the CLI: `service start|status|stop|doctor`.
 *
 * `start` spawns the SAME CLI binary with `serve --config ...` detached and
 * unref'd, writing a private log file inside the state dir, then waits (bounded)
 * for the socket to become ready. It only ever terminates the child it started,
 * and verifies readiness against that child's PID (or a raced pre-existing
 * owner). No paid model call is ever made by these commands.
 */
import { CliUsageError } from "./cli-args.js";
/** Result shape returned by every daemon command (JSON-serializable). */
export interface DaemonResult {
    readonly ok: boolean;
    readonly code?: string;
    readonly message?: string;
    readonly [key: string]: unknown;
}
/** Readiness probe: does a service answer `service.ping` at `socketPath`? */
export declare function probeService(socketPath: string, timeoutMs?: number): Promise<boolean>;
export interface StartOptions {
    /** Absolute path to the CLI entry point (bin/pi-durable.js). */
    readonly binPath: string;
    readonly configPath: string;
    readonly socketPath: string;
    readonly stateDir: string;
    /** Bounded readiness window in ms. */
    readonly readyTimeoutMs?: number;
    /**
     * Extra environment variables for the spawned service (e.g. a fixture
     * credential NAME set to a dummy value). Never used to pass real secrets to a
     * child we did not spawn ourselves.
     */
    readonly env?: Readonly<Record<string, string>>;
}
/**
 * Start a detached service for `configPath`, or report the already-running one.
 * On failure the spawned child is terminated so no orphan is left behind.
 */
export declare function startDaemon(options: StartOptions): Promise<DaemonResult>;
/** Stop a running service via the `service.shutdown` RPC and wait for the socket to vanish. */
export declare function stopDaemon(socketPath: string, timeoutMs?: number): Promise<DaemonResult>;
/**
 * Report service status without mutating anything.
 *
 * A missing socket file means "not running" (`ok:true`). A stale socket file (a
 * listener that refuses the connection), a permission error (EACCES/EPERM), or
 * a protocol/RPC failure all prove the service is NOT healthy and are reported
 * as `ok:false` with a distinct `code` so a script cannot mistake them for a
 * clean "stopped". We never use `existsSync` alone as a success signal: a stale
 * socket file would otherwise read as `running:false, ok:true`. Classification
 * lives in {@link classifyStatusError} (pure, unit-tested).
 */
export declare function statusDaemon(socketPath: string): Promise<DaemonResult>;
/**
 * Build a read-only doctor report (no store mutation, no network, no paid call).
 * `ok` requires: Node >= 22.19, macOS, a valid config, and sandbox-exec.
 * The verdict itself is {@link doctorOk} (pure, unit-tested).
 */
export declare function doctorReport(socketPath: string, configPath: string): DaemonResult;
export { CliUsageError };
export { classifyStatusError, doctorOk } from "./cli-status.js";
//# sourceMappingURL=cli-daemon.d.ts.map