import type { ChildProcess } from "node:child_process";
/** Protocol version this client understands. */
export declare const SUPERVISOR_VERSION = 1;
/** Maximum bytes per FD3 frame before the frame is treated as malformed. */
export declare const MAX_FRAME_BYTES: number;
export interface SupervisedExit {
    /** Exit code from the trusted FD3 frame, or null when killed by signal. */
    readonly code: number | null;
    /** Signal from the trusted FD3 frame, or null. */
    readonly signal: NodeJS.Signals | null;
}
export declare class SupervisorProtocolError extends Error {
    constructor(message: string);
}
/** Kill the whole watcher process group (cleanup), never the actual status. */
export declare function killWatcherGroup(child: ChildProcess, signal?: NodeJS.Signals): void;
/**
 * Attach an FD3 frame reader to the supervisor child. Returns a `waitFor`
 * helper that resolves with the first buffered frame of the requested type (or
 * rejects on a protocol error / channel close). Frames are bounded.
 */
export declare function attachStatusChannel(child: ChildProcess): {
    waitFor: <T extends {
        type: string;
    }>(type: string, timeoutMs: number | null) => Promise<T>;
    dispose: () => void;
};
/**
 * True while ANY process in process GROUP `pgid` is still alive.
 *
 * Probes the WHOLE group (`kill(-pgid, 0)`), not just the group leader: a dead
 * leader can leave same-PGID children running, so a leader-only probe would
 * wrongly report the group as reaped and let a caller free a lease behind a
 * live external command. EPERM means the group exists but is not signalable.
 */
export declare function isWatcherGroupAlive(pgid: number): boolean;
/**
 * Wait, bounded, for the WHOLE watcher process group to disappear after a
 * SIGKILL, escalating with an extra SIGKILL on the group. Returns true only
 * when the group is confirmed gone; false when it cannot be confirmed within
 * the window (the caller must then FAIL CLOSED).
 */
export declare function waitForWatcherGroupGone(child: ChildProcess, timeoutMs?: number, intervalMs?: number): Promise<boolean>;
//# sourceMappingURL=sandbox-supervisor.d.ts.map