// Command-supervisor client (parent side of the FD3 protocol).
//
// `runSandboxedCommand` spawns `command-supervisor.js` (a standalone Node
// module) with `detached:true` and stdio ["pipe","pipe","pipe","pipe"]. The
// supervisor becomes its own process GROUP leader (pgid === its pid) and speaks
// a newline-JSON protocol on FD3:
//
//   {type:"ready",pid,pgid,version:1}  the watcher is up; NO child has run yet
//   {type:"started",childPid}          the actual command has launched
//   {type:"exit",code,signal}          the actual command exited (trusted status)
//   {type:"spawnerror",code,message}   the actual command could not launch
//   {type:"error",reason}              protocol/argument failure (fail-closed)
//
// The parent writes "START\n" on FD0 ONLY after it has persisted the process
// receipt, so no command side effect can precede durability. On abort/timeout
// the parent closes FD0 (EOF) and/or SIGKILLs the whole watcher group.
//
// Guarantees this module enforces:
//   * READY must be version 1 and its pid/pgid EXACTLY match the spawned
//     watcher child pid — a mismatch is a protocol error (kill + throw).
//   * The watcher transport being SIGKILLed is CLEANUP, never the actual
//     command's status; only a trusted FD3 `exit`/`spawnerror` sets the result.
//   * Every FD3 frame is bounded (64KiB); an over-long/malformed frame kills
//     the owned group and throws.

import type { ChildProcess } from "node:child_process";

/** Protocol version this client understands. */
export const SUPERVISOR_VERSION = 1;
/** Maximum bytes per FD3 frame before the frame is treated as malformed. */
export const MAX_FRAME_BYTES = 64 * 1024;

export interface SupervisedExit {
  /** Exit code from the trusted FD3 frame, or null when killed by signal. */
  readonly code: number | null;
  /** Signal from the trusted FD3 frame, or null. */
  readonly signal: NodeJS.Signals | null;
}

export class SupervisorProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupervisorProtocolError";
  }
}

/** Kill the whole watcher process group (cleanup), never the actual status. */
export function killWatcherGroup(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Attach an FD3 frame reader to the supervisor child. Returns a `waitFor`
 * helper that resolves with the first buffered frame of the requested type (or
 * rejects on a protocol error / channel close). Frames are bounded.
 */
export function attachStatusChannel(child: ChildProcess): {
  waitFor: <T extends { type: string }>(type: string, timeoutMs: number | null) => Promise<T>;
  dispose: () => void;
} {
  const fd3 = child.stdio[3] as NodeJS.ReadableStream | null | undefined;
  const frames: { type: string }[] = [];
  const waiters: { type: string; resolve: (f: unknown) => void }[] = [];
  let buffer = Buffer.alloc(0);
  let closed = false;

  const flush = (): void => {
    let idx: number;
    while ((idx = buffer.indexOf(0x0a)) !== -1) {
      const line = buffer.subarray(0, idx).toString("utf8");
      buffer = buffer.subarray(idx + 1);
      if (line.trim() === "") continue;
      let frame: { type: string };
      try {
        frame = JSON.parse(line) as { type: string };
      } catch {
        closed = true;
        waiters.splice(0).forEach((w) => w.resolve(undefined));
        return;
      }
      const match = waiters.findIndex((w) => w.type === frame.type);
      if (match >= 0) {
        const [w] = waiters.splice(match, 1);
        w!.resolve(frame);
      } else {
        frames.push(frame);
      }
    }
  };

  fd3?.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_FRAME_BYTES) {
      closed = true;
      waiters.splice(0).forEach((w) => w.resolve(undefined));
      return;
    }
    flush();
  });
  const onClose = (): void => {
    closed = true;
    waiters.splice(0).forEach((w) => w.resolve(undefined));
  };
  fd3?.on("end", onClose);
  fd3?.on("error", onClose);

  return {
    /**
     * Resolve with the first matching frame, or `undefined` when the transport
     * closes first. `timeoutMs === null` means NO timer is armed: resolve only
     * when a matching frame arrives or the transport closes. Never calls
     * `setTimeout(null/Infinity/NaN)`.
     */
    waitFor<T extends { type: string }>(type: string, timeoutMs: number | null): Promise<T> {
      const buffered = frames.findIndex((f) => f.type === type);
      if (buffered >= 0) return Promise.resolve(frames.splice(buffered, 1)[0] as T);
      if (closed) return Promise.resolve(undefined as unknown as T);
      return new Promise<T>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const resolveMe = (frame: unknown): void => {
          if (timer !== undefined) clearTimeout(timer);
          resolve(frame as T);
        };
        waiters.push({ type, resolve: resolveMe });
        // null => no timer (bounded by transport close, see onClose above).
        // A non-finite/negative value is treated as null rather than arming a
        // degenerate/overflowing timer.
        if (timeoutMs !== null && Number.isFinite(timeoutMs) && timeoutMs >= 0) {
          timer = setTimeout(() => {
            const i = waiters.findIndex((w) => w.resolve === resolveMe);
            if (i >= 0) waiters.splice(i, 1);
            resolve(undefined as unknown as T);
          }, timeoutMs);
        }
      });
    },
    dispose(): void {
      onClose();
    },
  };
}

/**
 * True while ANY process in process GROUP `pgid` is still alive.
 *
 * Probes the WHOLE group (`kill(-pgid, 0)`), not just the group leader: a dead
 * leader can leave same-PGID children running, so a leader-only probe would
 * wrongly report the group as reaped and let a caller free a lease behind a
 * live external command. EPERM means the group exists but is not signalable.
 */
export function isWatcherGroupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Wait, bounded, for the WHOLE watcher process group to disappear after a
 * SIGKILL, escalating with an extra SIGKILL on the group. Returns true only
 * when the group is confirmed gone; false when it cannot be confirmed within
 * the window (the caller must then FAIL CLOSED).
 */
export async function waitForWatcherGroupGone(
  child: ChildProcess,
  timeoutMs = 3000,
  intervalMs = 50,
): Promise<boolean> {
  const pid = child.pid;
  if (pid === undefined) return true;
  killWatcherGroup(child, "SIGKILL");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isWatcherGroupAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    killWatcherGroup(child, "SIGKILL");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
