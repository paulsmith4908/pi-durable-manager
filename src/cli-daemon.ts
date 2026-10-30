/**
 * Detached daemon lifecycle for the CLI: `service start|status|stop|doctor`.
 *
 * `start` spawns the SAME CLI binary with `serve --config ...` detached and
 * unref'd, writing a private log file inside the state dir, then waits (bounded)
 * for the socket to become ready. It only ever terminates the child it started,
 * and verifies readiness against that child's PID (or a raced pre-existing
 * owner). No paid model call is ever made by these commands.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { open, mkdir, chmod, rm } from "node:fs/promises";
import { existsSync, constants as FS } from "node:fs";
import { join } from "node:path";
import { PiClient } from "./client.js";
import { redactError } from "./redact.js";
import { CliUsageError } from "./cli-args.js";
import { classifyStatusError, doctorOk } from "./cli-status.js";

/** Result shape returned by every daemon command (JSON-serializable). */
export interface DaemonResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly [key: string]: unknown;
}

/** Readiness probe: does a service answer `service.ping` at `socketPath`? */
export async function probeService(socketPath: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const client = await PiClient.connect({ socketPath, timeoutMs });
    try {
      await client.call("service.ping", {}, "cli-probe");
      return true;
    } finally {
      client.close();
    }
  } catch {
    return false;
  }
}

/** Ask the running service for its status (PID etc.). Null when unreachable. */
async function readServiceStatus(socketPath: string, timeoutMs = 2000): Promise<Record<string, unknown> | null> {
  try {
    const client = await PiClient.connect({ socketPath, timeoutMs });
    try {
      return (await client.call("service.status", {}, "cli-status")) as Record<string, unknown>;
    } finally {
      client.close();
    }
  } catch {
    return null;
  }
}

async function waitForReady(socketPath: string, deadlineMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await probeService(socketPath)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** True once `pid` no longer exists (best-effort; ESRCH = gone). */
function waitForExit(child: ChildProcess, deadlineMs: number): Promise<void> {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolvePromise();
    const timer = setTimeout(resolvePromise, deadlineMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

/** Terminate only the child we spawned, then wait for it to actually exit. */
async function terminateOwnChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  await waitForExit(child, 5000);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    await waitForExit(child, 2000);
  }
}

/** Open a private (0600), non-symlink regular-file log inside stateDir. */
async function openLogFile(stateDir: string): Promise<{ fd: number; close: () => Promise<void>; path: string }> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  try {
    await chmod(stateDir, 0o700);
  } catch {
    /* best-effort; may fail on some filesystems */
  }
  const logPath = join(stateDir, "service.log");
  const handle = await open(
    logPath,
    FS.O_WRONLY | FS.O_CREAT | FS.O_APPEND | FS.O_NOFOLLOW,
    0o600,
  );
  const info = await handle.stat();
  if (!info.isFile()) {
    await handle.close();
    throw new CliUsageError("bad_log", `Log path is not a regular file: ${logPath}`);
  }
  return { fd: handle.fd, close: () => handle.close(), path: logPath };
}

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
export async function startDaemon(options: StartOptions): Promise<DaemonResult> {
  await rm(join(options.stateDir, "guard-pause.json"), { force: true });
  if (await probeService(options.socketPath)) {
    return { ok: true, alreadyRunning: true, socketPath: options.socketPath, pid: null };
  }

  const log = await openLogFile(options.stateDir);
  const logPath = log.path;
  let child: ChildProcess | undefined;
  let spawnError: Error | undefined;
  try {
    child = spawn(
      process.execPath,
      [options.binPath, "serve", "--config", options.configPath, "--socket", options.socketPath],
      { detached: true, stdio: ["ignore", log.fd, log.fd], env: { ...process.env, ...(options.env ?? {}) } },
    );
    child.on("error", (error) => {
      spawnError = error;
    });
    child.unref();
    const ready = await waitForReady(options.socketPath, options.readyTimeoutMs ?? 10_000);

    if (!ready) {
      await terminateOwnChild(child);
      return {
        ok: false,
        code: spawnError ? "spawn_failed" : "start_timeout",
        message: spawnError
          ? `Failed to spawn service: ${redactError(spawnError).message}`
          : "Service did not become ready before the bounded timeout.",
        logPath,
      };
    }

    // Verify the answering service is OUR child (or a raced pre-existing owner
    // that won the bind). Misc. PIDs are not trusted.
    const status = await readServiceStatus(options.socketPath);
    const servicePid = typeof status?.pid === "number" ? (status.pid as number) : null;
    if (child.pid !== undefined && servicePid !== null && servicePid !== child.pid) {
      // A different owner won the race; leave it running, do not claim our child.
      await terminateOwnChild(child);
      return {
        ok: true,
        alreadyRunning: true,
        socketPath: options.socketPath,
        pid: servicePid,
        logPath,
      };
    }
    return { ok: true, alreadyRunning: false, socketPath: options.socketPath, pid: child.pid ?? null, logPath };
  } finally {
    // Close our dup'd fd; the detached child keeps its own copy open.
    await log.close().catch(() => undefined);
  }
}

/** Stop a running service via the `service.shutdown` RPC and wait for the socket to vanish. */
export async function stopDaemon(socketPath: string, timeoutMs = 5000): Promise<DaemonResult> {
  if (!existsSync(socketPath)) {
    return { ok: true, alreadyStopped: true, socketPath };
  }
  try {
    const client = await PiClient.connect({ socketPath, timeoutMs });
    try {
      const result = await client.call("service.shutdown", {}, "cli-stop");
      void result;
    } finally {
      client.close();
    }
  } catch (error) {
    return { ok: false, code: "stop_failed", message: redactError(error).message };
  }
  // Wait for the service to actually go away (bounded).
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!existsSync(socketPath) && !(await probeService(socketPath, 500))) {
      return { ok: true, stopped: true, socketPath };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { ok: false, code: "stop_timeout", message: "Service did not stop in time.", socketPath };
}

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
export async function statusDaemon(socketPath: string): Promise<DaemonResult> {
  try {
    const client = await PiClient.connect({ socketPath, timeoutMs: 3000 });
    try {
      const status = await client.call("service.status", {}, "cli-status");
      if (status === null || typeof status !== "object") {
        // Connected but the peer spoke something we do not understand: a
        // protocol failure, not a healthy service. Never a false success.
        return {
          ok: false,
          running: false,
          code: "protocol_error",
          message: "service.status returned a non-object payload",
          socketPath,
        };
      }
      return { ok: true, running: true, socketPath, status: status as Record<string, unknown> };
    } finally {
      client.close();
    }
  } catch (error) {
    const code = (error as { code?: string }).code;
    // The client surfaces BOTH "socket file absent" and "socket file present but
    // nothing healthy listening" as a single transport code (`unavailable`). We
    // must split them: a genuinely absent socket file is a clean `no_socket`
    // (`ok:true`, exit 0), while a present-but-refusing socket is a STALE
    // failure (`ok:false`, non-zero). Existence is used only to disambiguate the
    // two failure modes — never as the success signal itself (a stale file
    // exists yet is not a running service).
    if (code === "unavailable" && !existsSync(socketPath)) {
      return { ok: true, running: false, code: "no_socket", socketPath };
    }
    const classified = classifyStatusError(code);
    if (classified.ok) {
      return { ok: true, running: false, code: classified.code, socketPath };
    }
    return { ok: false, running: false, code: classified.code, message: redactError(error).message, socketPath };
  }
}

/**
 * Build a read-only doctor report (no store mutation, no network, no paid call).
 * `ok` requires: Node >= 22.19, macOS, a valid config, and sandbox-exec.
 * The verdict itself is {@link doctorOk} (pure, unit-tested).
 */
export function doctorReport(socketPath: string, configPath: string): DaemonResult {
  const [major = 0, minor = 0] = process.versions.node.split(".").map((p) => Number(p));
  const nodeOk = major > 22 || (major === 22 && minor >= 19);
  const platform = process.platform;
  const platformOk = platform === "darwin";
  const sandboxExecAvailable = platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
  const configPresent = existsSync(configPath);
  const ok = doctorOk({ nodeOk, platformOk, sandboxExecAvailable, configPresent, configOk: true });
  return {
    ok,
    node: process.versions.node,
    nodeOk,
    requires: ">=22.19.0",
    platform,
    platformOk,
    arch: process.arch,
    sandboxExec: sandboxExecAvailable ? "available" : "blocked",
    sandboxExecAvailable,
    configPath,
    configPresent,
    socketPresent: existsSync(socketPath),
    socketPath,
  };
}

export { CliUsageError };
// Re-export the pure status/doctor helpers so existing importers of this module
// keep working (they are defined once in cli-status.ts).
export { classifyStatusError, doctorOk } from "./cli-status.js";
