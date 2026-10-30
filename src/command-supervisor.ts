// integration/command-supervisor.ts
//
// Standalone command lifetime supervisor (Node builtins only).
//
// Launched by a controller as:
//   process.execPath [supervisor.ts, "--grace-ms", "500", "--", program, ...args]
// with detached:true and stdio ["pipe","pipe","pipe","pipe"].
//
//   * FD0 is the ONLY parent lifetime / control pipe ("START\n" / "STOP\n").
//   * FD3 is a private newline-JSON status channel (never inherited by the child).
//
// The supervisor becomes its own process group (pgid === supervisor pid). It emits
// {type:"ready",pid,pgid,version:1} on FD3, then MUST wait for "START\n" before it
// launches the actual command. This lets the controller persist the PGID receipt
// BEFORE any command side effect. If the parent pipe ends before START, no child
// runs. Once started, the supervisor forwards child stdout/stderr UNMODIFIED and
// emits {type:"exit",code,signal}; it stays alive awaiting parent cleanup. When the
// parent pipe closes, a STOP line arrives, or SIGTERM/SIGINT is received, the
// supervisor stops ONCE: it signals its OWN process group TERM, then after a
// bounded (referenced) grace SIGKILLs the whole group (including itself). Stop
// ALWAYS cleans the group regardless of the primary command's exit state, so
// normal descendants cannot outlive a parent death that lands after the primary
// exited.
//
// This module never touches inference, credentials, or any foreign pid/group.

import { spawn, type ChildProcess } from "node:child_process";
import { writeSync } from "node:fs";

const VERSION = 1;
const START_TIMEOUT_MS = 10_000;
const MIN_GRACE_MS = 10;
const MAX_GRACE_MS = 5_000;
const FD3 = 3;
const MAX_LINE = 4096;

interface Parsed {
  ok: boolean;
  reason?: string;
  graceMs: number;
  program: string;
  args: string[];
}

function parseArgv(argv: string[]): Parsed {
  const bad = (reason: string): Parsed => ({ ok: false, reason, graceMs: 0, program: "", args: [] });
  let graceMs = 500;
  let i = 0;
  let sawDashDash = false;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { sawDashDash = true; i++; break; }
    if (a === "--grace-ms") {
      const raw = argv[++i];
      if (!/^\d+$/.test(raw ?? "")) return bad("grace-ms must be an integer");
      graceMs = Number(raw);
      if (!Number.isInteger(graceMs) || graceMs < MIN_GRACE_MS || graceMs > MAX_GRACE_MS) {
        return bad(`grace-ms out of range ${MIN_GRACE_MS}..${MAX_GRACE_MS}`);
      }
      continue;
    }
    return bad(`unknown argument: ${a}`);
  }
  if (!sawDashDash) return bad("missing -- separator");
  const rest = argv.slice(i);
  if (rest.length === 0 || !rest[0]) return bad("missing program after --");
  return { ok: true, graceMs, program: rest[0], args: rest.slice(1) };
}

function main(): void {
  const parsed = parseArgv(process.argv.slice(2));

  let stopped = false;
  let exited = false;
  let started = false;
  let killTimer: NodeJS.Timeout | undefined;
  let startTimer: NodeJS.Timeout | undefined;
  let child: ChildProcess | undefined;

  const writeFd3 = (obj: Record<string, unknown>): boolean => {
    try {
      writeSync(FD3, Buffer.from(JSON.stringify(obj) + "\n", "utf8"));
      return true;
    } catch {
      return false;
    }
  };

  // Fail closed: the status channel is mandatory.
  const failClosed = (reason: string): void => {
    if (!writeFd3({ type: "error", reason })) process.exitCode = 2;
    process.exit(2);
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (startTimer) clearTimeout(startTimer);
    // NOTE: we deliberately do NOT short-circuit on `exited`. The primary command
    // may have exited while leaving normal (non-detached) descendants alive, and
    // the parent may die BEFORE its normal cleanup runs. Stop must ALWAYS clean the
    // whole group regardless of the primary command's exit state.
    const ownGroup = process.pid; // we are our own group leader (detached:true)
    const killGroup = (sig: NodeJS.Signals): void => {
      try { process.kill(-ownGroup, sig); } catch { /* group already gone */ }
    };
    // Ignore further TERM/INT so we do not recurse into this handler.
    process.on("SIGTERM", () => {});
    process.on("SIGINT", () => {});
    killGroup("SIGTERM");
    // Keep the grace timer REFERENCED: if stdin hits EOF right after the primary
    // exited, an unref'd timer would let the supervisor exit before the grace
    // SIGKILL, orphaning TERM-ignoring descendants. It must stay referenced.
    killTimer = setTimeout(() => { killGroup("SIGKILL"); process.exit(0); }, parsed.graceMs);
    killTimer.ref?.();
  };

  // Runtime FD3 write failure after START is unrecoverable: we can no longer
  // report the real command status, so we must fail closed on our own scope
  // (stop the group) rather than silently continue without a status channel.
  const writeFd3OrStop = (obj: Record<string, unknown>): void => {
    if (!writeFd3(obj)) stop();
  };

  if (!parsed.ok) { failClosed(parsed.reason ?? "invalid arguments"); return; }

  // Ready first: the controller persists the PGID receipt, THEN sends START.
  if (!writeFd3({ type: "ready", pid: process.pid, pgid: process.pid, version: VERSION })) {
    process.exit(2);
    return;
  }

  function launch(): void {
    started = true;
    if (startTimer) clearTimeout(startTimer);
    try {
      // Child inherits ONLY stdio 0 ignore / 1 stdout / 2 stderr, in OUR group.
      child = spawn(parsed.program, parsed.args, {
        stdio: ["ignore", "inherit", "inherit"],
        detached: false,
      });
    } catch (err) {
      writeFd3OrStop({ type: "spawnerror", code: 127, message: String((err as Error)?.message ?? err) });
      stop();
      return;
    }
    writeFd3OrStop({ type: "started", childPid: child.pid });
    child.on("error", (err: NodeJS.ErrnoException) => {
      const code = err && err.code === "ENOENT" ? 127 : 126;
      writeFd3OrStop({ type: "spawnerror", code, message: String(err?.message ?? err) });
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      exited = true;
      writeFd3OrStop({ type: "exit", code: code === null ? null : code, signal: signal ?? null });
      // Stay alive awaiting parent cleanup; never exit on our own here.
    });
  }

  // FD0: parent lifetime / control. Any end or malformed input stops us.
  let buf = "";
  const onData = (chunk: Buffer): void => {
    buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line === "START") { if (!started) launch(); }
      else if (line === "STOP") stop();
      else stop(); // unknown non-interactive protocol input: stop
      if (stopped) return;
    }
    if (buf.length > MAX_LINE) stop(); // unbounded line => malformed
  };

  process.stdin.on("data", onData);
  process.stdin.on("end", () => stop());
  process.stdin.on("close", () => stop());
  process.stdin.on("error", () => stop());
  process.on("SIGTERM", () => stop());
  process.on("SIGINT", () => stop());

  // Fail closed if START never arrives.
  startTimer = setTimeout(() => {
    if (!started) { writeFd3({ type: "error", reason: "start-timeout" }); stop(); }
  }, START_TIMEOUT_MS);
  startTimer.unref?.();
}

main();
