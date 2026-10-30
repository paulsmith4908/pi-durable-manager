# Process handoff — command lifetime supervisor

A **small standalone** process supervisor that guarantees a tool's command and its
normal descendants cannot outlive the lease that authorized them. It is wired by
`src/sandbox.ts`'s `runSandboxedCommand`; this document is the contract that wiring
honors.

Scope: `src/command-supervisor.ts`, `src/sandbox-supervisor.ts`,
`tests-assets/process-lifetime.test.mjs`, this file. **Node builtins only**; no
commits, no network, no real manager/private-config edits, no shell-temp/`OLDPWD`
cleanup. Fixtures use a `pi-supervisor-test-` prefix guard and signalled pids are
limited to tracked fixture pids.

## Launch contract

The controller (service) launches the supervisor as a **detached process group
leader**:

```
process.execPath [compiledSupervisor, "--grace-ms", "500", "--", program, ...args]
  detached: true
  stdio:    ["pipe","pipe","pipe","pipe"]
```

- **FD0** — the *only* parent-lifetime/control pipe. Newline lines: `START`, `STOP`.
- **FD1/FD2** — the supervisor's stdout/stderr; the child inherits these unmodified.
- **FD3** — a *private* newline-JSON status channel. Never inherited by the child.
  Frames are newline-delimited JSON, **bounded to 64 KiB per frame**; a frame over
  the bound (or malformed JSON) fails the protocol closed. The first frame is `ready`.
  The controller validates `version === 1` and that `pid`/`pgid` **exactly** match the
  spawned watcher child before trusting any frame.

The supervisor makes itself its own process group (`pgid === supervisor pid`). In
production the `program`/`args` are `sandbox-exec` + the profile + `bash`; the
**test seam** runs the real `bash` **unsandboxed**.

## Protocol (FD3 frames, newline-delimited JSON)

| frame | fields | meaning |
|---|---|---|
| `ready` | `pid`, `pgid`, `version:1` | emitted **before** any command side effect |
| `started` | `childPid` | command spawned (after `START`) |
| `exit` | `code`, `signal` | command finished; supervisor stays alive |
| `spawnerror` | `code`, `message` | command could not start (`code:127` for `ENOENT`) |
| `error` | `reason` | fail-closed (`invalid`, `start-timeout`, `fd3-write-failed`) |

### Start barrier

1. Supervisor emits `ready` with its pgid.
2. The controller **persists the process receipt synchronously** (`ProcessHooks.onProcess`
   `{pid, group, state:"started", command}`) **before** writing `START\n`.
3. Only on `START\n` does the supervisor spawn the actual command (arg array, no
   shell wrapper here) with `stdio:["ignore","inherit","inherit"]`, `detached:false`
   — i.e. the child is in the **supervisor's group** and inherits **only** stdio
   0/1/2, never FD3 and never the parent-lifetime pipe.

If the parent pipe closes **before** `START`, **no child ever runs**. A `START` that
never arrives within 10 s yields `error:start-timeout` and a fail-closed stop.

## Teardown

On **any** of: parent pipe close/end, `STOP\n`, `SIGTERM`, or `SIGINT` — the
supervisor stops **exactly once**:

1. install empty `SIGTERM`/`SIGINT` handlers to avoid recursive self-signalling,
2. `kill(-ownGroup, "SIGTERM")` (own group only — never a foreign pid/group),
3. after the bounded `--grace-ms`, `kill(-ownGroup, "SIGKILL")` (whole group,
   **including self**).

**Stop always cleans the group — regardless of the primary command's exit state.**
There is deliberately **no** `if (exited) return/exit` short-circuit: the primary
command may exit 0 while leaving normal (non-detached) descendants alive, and the
parent may die *after* that exit but *before* its normal cleanup runs. Stop must
still TERM→SIGKILL the whole group so those descendants cannot outlive the lease.

The grace timer is **referenced** (never `unref`'d). If FD0 hits EOF right after the
primary exited, an unref'd timer would allow the supervisor to exit before the grace
`SIGKILL`, orphaning `TERM`-ignoring descendants. It stays referenced until the group
kill runs.

`--grace-ms` must be an integer in `10..5000`; anything else fails closed. A command
that ignores `TERM` is still `SIGKILL`ed because the `SIGTERM` is delivered to the
**group**. Malformed/unknown non-interactive input on FD0 also triggers a stop.

### Fail-closed on FD3

The status channel is mandatory. If the **initial** `ready` write fails the
supervisor exits **2 with no child**. If an FD3 write **fails at runtime after
`START`** (e.g. the controller closed FD3), the supervisor can no longer report the
real command status, so it **fails closed on its own scope** — it stops the group
rather than silently continuing without a status channel.

## Parent-death rule

The parent-lifetime pipe (FD0) is the death signal. When the launcher dies, FD0
reaches EOF and the supervisor kills its whole group — so **normal descendants cannot
outlive the lease even if the command ignores `TERM`, and even if the primary command
already exited cleanly before the parent died**.

> **Normal transport exit is `SIGKILL`.** In the usual path the controller records
> the real outcome from the trusted FD3 `exit` frame, *then* kills the supervisor
> group. That group kill surfaces as `SIGKILL` on the supervisor itself, so the
> controller **must use the FD3 `exit` status** (not the supervisor's own wait
> status) as the `CommandResult`.

## Service wiring (for the later Pi worker)

- Spawn the **watcher** as a detached process group.
- **Persist the process receipt synchronously** via `ProcessHooks.onProcess`
  (`state:"started"`) **before** writing `START\n`.
- Parse FD3 with a **bounded** frame parser; **validate `version===1` and the
  exact `pid`/`pgid`** on `ready`.
- Use the FD3 `exit` frame as the authoritative command result.
- **Kill and JOIN the whole PGID** and **confirm the group is gone** — probe
  `kill(-pgid, 0)` (EPERM ⇒ alive), not a leader-only probe, since a dead leader can
  leave same-PGID children — **before** `onProcess({state:"stopped"})` / `onCommand` /
  lease release. If the group cannot be confirmed gone, **fail closed** (no stopped
  receipt, no result) so the lease is retained.
- **Unclean startup ⇒ quarantine the assignment for review**, applied **before** any
  durable conversation is resumed (no blind re-run): wait for the old PGID to be gone,
  and **do not** kill an unverified, possibly-reused PGID.
- A GUI client disconnect does **not** stop the service; a daemon crash **does** stop
  its tools.
- **Exactly-once external command execution is NOT claimed.**

## Tests (`tests-assets/process-lifetime.test.mjs`)

Real `detached:true` supervisor with an FD3 pipe. Covers: no execution before
`START`; real stdout/stderr/`exit 7` preserved via IPC; `ENOENT` ⇒ structured
`spawnerror` `code:127` (no fake success); `STOP` kills the command group; parent
lifetime pipe close kills the command; a `TERM`-ignoring command is still killed;
launcher parent death kills supervisor + descendants; child does not inherit FD3 or
the parent-lifetime pipe (stdin is `/dev/null`); invalid args stop fail-closed;
**parent death (or `STOP`) after the primary exited 0 still kills a `TERM`-ignoring
normal grandchild — its post-grace marker is never written and the supervisor group is
gone after the grace**; **a closed FD3 before `ready` exits 2 with no child, and a
runtime FD3 failure after `START` fails closed on the group**; and a guard that
refuses to signal untracked pids. Cleanup runs in `finally` and signals only tracked
fixture pids — no real Codex/manager pid is ever signalled.

These tests process-control the supervisor itself, so they run **directly** (they are
not SBPL-sandboxed); the actual kernel `sandbox-exec` wrapper is tested elsewhere.
