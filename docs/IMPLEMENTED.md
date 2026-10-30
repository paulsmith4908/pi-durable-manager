# Implementation status — pi-durable-manager

This document records what is **actually implemented** in the `pi-durable-manager` package. It
contains no planned or future work; if a capability is not listed here as implemented, do not
assume it exists.

## What is implemented

### Release correctness (0.3.0-beta.1)

Five source-reviewed correctness fixes are implemented and covered by tests:

- **Durable receipt is written before any mutation.** The `--online` check persists its initial run
  receipt **atomically (temp + rename, mode 0600)** *before* any project/session/bind/assignment
  call. If that write cannot be persisted, the check **FAILs non-zero and submits nothing** — it no
  longer swallows the error and reports `run_record` PASS. A failure after a durable submit is
  reported truthfully with the recoverable `requestId` and known IDs (redacted) and is **never
  re-submitted**; completed project/state is preserved. Injection seam `RunStoreFs`
  (`OnlineCheckOptions.runFs`) lets tests force the write to fail.
- **Honest delivery/verify verdicts.** The event receipt reads the **actual**
  `deliveryState`/`attempts`/`receipt`/`acked` from `manager.events`; an existing row is **not**
  labelled `delivered`. `--verify` reads the **direct** shape returned by `assignments.show`
  (`{ state, ... }`, not a nested `{assignment:{state}}` wrapper) and requires assignment
  `accepted` **+** event `delivered` **+** event acked for PASS; running/needs-review/unacked is
  **PENDING**; failed/unanswered/cancelled/unknown/missing-ID is **FAIL**. It never auto-accepts an
  assignment and never acks a live event.
- **Truthful service compatibility.** `service version`/`service status` now include the installed
  **package** version (from `src/version.ts`, resolved from `package.json`, no circular setup
  import). `--online` strictly validates **package version, protocol, state dir, config path,
  provider id (`modal`) and model** and **stops before creating any project** on mismatch or if the
  status cannot be read. It never stops the user's daemon.
- **Portable release scanner.** `scripts/build-release.mjs` derives personal-name/path rules
  **dynamically** from the running user, home, and checkout (no hardcoded username or workspace
  fragments, not even as string literals). The source bundle includes `src/tests/tests-assets/
  scripts/skill/plugin/example/docs/bin` and excludes private incident history
  (`STALL-DIAGNOSIS*.md`).
- **Stat-only credential-file validation.** `apiKeyFile` is validated by **metadata only** — regular
  file, not a symlink (never followed), owner-only mode (`0600`); the **bytes are never read**, so a
  raw key pasted into the path is never displayed. A directory/symlink/world-readable file is a
  **FAIL**; a missing file is a **WARN**.

### Service (local daemon, single writer)

- A local JSON-RPC v1 service over a **Unix-domain socket**, owned by exactly one process per
  state directory (`OwnerLock`, reclaims a provably dead owner, never deletes another pid's lock).
- **Detached lifecycle**: `service start` spawns the same CLI binary as `serve --config ...`
  detached + unref'd, logging to a private `service.log` (0600), then waits (bounded, default 10s)
  for the socket and verifies the answering pid is its own child. `service stop` sends
  `service.shutdown` and waits for the socket to vanish. `service status` and `service doctor` are
  read-only.
- **Independent of the GUI**: the daemon keeps running when the Codex GUI chat is closed. When a
  project is **bound** to a manager thread, the service wakes Codex automatically via the documented
  `codex queue` CLI on meaningful state changes (event mode); no LLM is called and nothing is
  dispatched while state is unchanged.
- `service doctor` requires Node >= 22.19, macOS, a present config, and `/usr/bin/sandbox-exec`.
- Deterministic short socket path under `/tmp/pi-durable-<uid>/<statehash>/s`, independent of the
  (often long) source path; an over-long path is an explicit error, not a truncation.

### Protocol methods (the exact implemented surface)

`service.ping`, `service.status`, `service.version`, `service.capabilities`, `service.shutdown`;
`projects.create`, `projects.import`, `projects.list`, `projects.show`;
`sessions.create`, `sessions.list`, `sessions.inspect`, `sessions.transcript`, `sessions.entry`,
`sessions.tasks`, `sessions.usage`, `sessions.usageGlobal`, `sessions.fork`, `sessions.compact`,
`sessions.configure`, `sessions.reset`, `sessions.steer`, `sessions.followup`;
`assignments.create`, `assignments.submit`, `assignments.show`, `assignments.inspect`,
`assignments.list`, `assignments.wait`, `assignments.abort`, `assignments.cancel`,
`assignments.review`, `assignments.recover`, `assignments.evidence`, `assignments.artifact`,
`assignments.checkpoint`, `assignments.restore`;
`manager.bind`, `manager.unbind`, `manager.list`, `manager.status`, `manager.events`, `manager.ack`,
`manager.decision`; `activity.list`, `activity.note`; `supervision.configure`, `supervision.status`.

The local-reliability surface (`activity.list`, `activity.note`, `supervision.configure`,
`supervision.status`, `manager.decision`) is additive and capability-gated: `service.capabilities`
lists it, and older clients simply ignore it. See `docs/LOCAL-RELIABILITY.md` for the exact
descriptors, policy fields/defaults, and the decision-before-action + acknowledgement workflow.

`service.capabilities` returns the **method names** above plus an `unsupported` list and an
`operations` map describing each method's parameters (idempotency keys included). It does **not**
return a full JSON-schema per method.

The **idempotency-aware** client injects `requestId` automatically for `sessions.fork`,
`sessions.steer`, `sessions.followup`, and `assignments.recover` (alongside the create/submit
methods), so a retried call replays instead of duplicating; a mismatched `requestId` on a retry is
a `request_id_mismatch` client error.

### Automatic manager wake (event mode)

- The service observes assignment state transitions itself and writes ONE durable event to a
  **manager outbox in the same MetadataStore SQLite** (single writer; **schema 7**, with a backward
  migration that adds the `manager_bindings`/`manager_events` tables to an existing schema-6 db).
  Classification is **code-only** — **no LLM is called** and **nothing is dispatched while state is
  unchanged**.
- Wake kinds: `needs_review`, `blocked`, `failed`, `unanswered`, `budget`, `timeout`,
  `manager_request`. Routine transitions (`accepted`, `revision_requested`, ordinary commands) and
  explicit operator cancels do **not** wake.
- Events are deduplicated by a stable event id (`ON CONFLICT(dedup_key) DO NOTHING`); same-state
  updates and already-acked events are skipped. A wake prompt carries **ids + bounded summaries**,
  never a raw transcript or raw worker instructions.
- A **project → manager thread binding** is explicit and effective **from now** (no historical
  replay); an already-running assignment whose future terminal is a wake **will** notify. A Pi
  worker can **never** choose/change the target thread or run Codex.
- The dispatcher runs **outside any LLM loop**, spawning the documented
  `codex queue --thread <UUID> --message <TEXT>` as an **ARGV array (no shell)** under a minimal
  trusted-host env allowlist (`PATH`/`HOME`/locale/platform paths) — **no model API key or provider
  secret** is passed, and **no Codex daemon is bootstrapped or restarted**. Bounded, redacted
  delivery diagnostics are recorded.
- Delivery is **at-least-once**: a CLI kill/timeout can land after the queue already accepted the
  message; event ids + the manager ack prevent duplicate work. There is **no exactly-once claim**.
  Pending failures retry with bounded backoff (no idle LLM heartbeat); startup drains durable
  pending events; stop cancels/joins any owned CLI child. A missing/offline/non-zero `codex` CLI is
  surfaced honestly (never a fake success) via `manager.status`.
- **Worker `request_manager` (needs-intervention):** a blocked worker calls the `request_manager`
  tool (`question`, optional `context`). The trusted callback binds only the **current**
  assignment/project/conversation. Pausing is **two-phase and durable**:
  1. **Intent (synchronous, gated immediately):** a durable `manager_pause_intents` row is written
     **and** the assignment is moved to `blocked`/`manager_request` in a **single transaction**,
     so no further code/tool side effects or provider dispatch are admitted from that instant. No
     outbox event is written yet. The tool returns a truthful
     `{ ok: true, intentId, state: "pausing" }` — never a fabricated event id.
  2. **Finalizer (async, outside the tool's own task):** the run scope/process groups are aborted,
     the project's owned process groups are **drained and confirmed** (with a cleanup warning
     folded into the wake if they do not) and then the **final `blocked` state + exactly ONE
     `manager_request` outbox event** are written together in one transaction. The intent records
     the **actual persisted event id** (or is truthfully marked `failed` if cleanup/write could not
     be confirmed — the question is never lost).

  The intent is preserved across restart and finished by startup reconciliation. The lease is
  **retained** until the manager reviews/cancels/answers. The pause is truthful and deterministic
  (code, not an LLM judge); the intentional pause is **never** relabelled `budget`/`timeout`/`failed`.
  There is no automatic commit or publication.

### Deliberately unsupported (by design)

- `conversation.submit` — a bare conversation write would bypass the assignment lease/budget, so
  it is refused. Steering/follow-up must route through `sessions.steer` / `sessions.followup`
  (which require an `assignmentId`) or a new assignment.
- `sessions.delete`, `projects.delete` — recognized but not implemented; calling them returns a
  real `not_yet_implemented` / method error (never a fake success).

### Projects

- `projects.create` makes a **fresh local Git repository** under an allowed root (`git init`),
  refusing to overwrite an existing path. The parent directory (`projectHome`) **must already
  exist**; the service does not create it.
- `projects.import` imports an **existing local Git repository** in place (never overwrites
  files), canonical-path de-duplicated so one checkout maps to one project.
- Both enforce the configured `paths.allowedRoots` boundary via canonical (symlink-resolved) paths
  and reject the service state directory. No GitHub remote is created.

### Assignments (bounded-scope, leased work)

- `assignments.submit` (and its alias `assignments.create`) admits a bounded-SCOPE task with an
  optional criteria file; the `requestId` is the idempotency key (a retry with the same id and
  payload replays; a different payload under the same id is a `conflict`). Request IDs are
  preserved across an ambiguous retry. "Bounded" means a clear, reviewable scope — assignments MAY
  run for hours and are **not** time-boxed by default.
- **Execution budgets are unlimited by default.** `limits.maxSteps` and `limits.timeoutMs` accept
  `null` (and omission) as **unlimited**; positive finite safe integers remain valid and bound the
  run. A project may set a positive finite `tools.commandTimeoutMs` cap for normal foreground bash
  commands (`null` = unlimited). An unlimited assignment persists `deadlineAt: null` and never arms
  a deadline timer; the step counter stays accurate for both capped and uncapped runs.
- `assignments.wait` performs a **bounded wait** (`timeoutMs`, ≤ 60s) that is **independent** of the
  assignment's execution budget. For `assignments.wait`, `--timeout-ms` is forwarded to the server
  as `params.timeoutMs` **and** sizes the client wait `requested + 5s` (capped at 65s) so the server
  — which caps waits at 60s — always replies before the client gives up. A wait bound supplied via
  `--params-file` is honoured client-side too. An unlimited global `limits.timeoutMs` does **not**
  turn this into an unbounded or zero wait.
- `assignments.review` records a `decision` of `accept` or `revise` (a `revise` typically produces
  a **new** assignment referencing `parentId`). `accept` is **async** and re-verifies the CURRENT
  tree against the assignment's recorded after-snapshot: a file that was added, modified, or
  deleted since settlement makes the review fail with a structured `evidence_stale` error (carrying
  the offending paths) instead of silently accepting stale work.
- Evidence is real: changed files, untracked files, test logs, exit codes.

### Evidence, checkpoints, artifacts, and restore

- **Pre-admission checkpoint.** Before an assignment ever contacts the provider, the engine captures
  a baseline snapshot and writes a private pre-image checkpoint (0700 dirs, 0600 files). If that
  checkpoint is incomplete, admission **fails closed** (state `blocked`, error
  `checkpoint_incomplete`) with **zero provider requests**. The complete pre-admission bundle is
  persisted to the assignment row *before* dispatch, so `assignments.checkpoint` can resolve it.
- **Protected/private pre-images.** The checkpoint lives under the protected state dir and never
  inside the project checkout; the sandbox exception is scoped to the assignment scratch dir only.
- **Command hooks are durable and parallel-safe.** Every shell/tool command is recorded with a
  monotonic `seq` via a synchronous read-modify-write, so commands resolving out of order never
  drop a record. Command **summaries are redacted** (both the command line and the stdout/stderr
  tails), and the full output is copied to an **immutable** artifact only when it overflows the
  inline tail and originates from a canonical path inside the assignment scratch dir.
- **Before/after hashing.** The engine diffs an after-snapshot against the pre-admission baseline
  and reports only real `added`/`deleted`/`modified` files. A pre-existing **unchanged** untracked
  file is never reported as changed.
- `assignments.evidence` returns a redacted, structured evidence bundle for the assignment; a
  **legacy** row (written before structured bundles existed) is refused with `evidence_unavailable`
  unless `allowLegacy: true` is passed, in which case the raw stored summary is returned with
  `legacy: true` and a clear note.
- `assignments.artifact` streams one recorded command-output artifact in bounded chunks
  (`{id, artifactId, offset, maxChars}`, ≤ 64 KiB per chunk). Reads are **scoped to artifact ids
  actually recorded** for the assignment; an unknown id is refused. Artifact content is redacted.
- `assignments.checkpoint` returns the recorded checkpoint ref, verified/completeness flags, and
  file counts.
- `assignments.restore` restores the assignment's **pre-admission baseline** (the tree state at
  admission, not the worker's produced output). It is **missing-only by default**: existing files
  (including later human edits) are left untouched and reported under `skipped`; pass
  `overwrite: true` to explicitly opt into clobbering them with the pre-image. It is
  **idempotent** — a repeated call with the same `requestId` and payload replays the stored result,
  while a different payload under the same `requestId` is a `conflict`. A concurrent writer lease on
  the project refuses the restore (`lease_held`).

### Checkpoint limits

The pre-admission checkpoint is bounded: at most **2000 files**, **10 MiB** per file, and
**256 MiB** total; command summaries keep the last **4096 bytes** of each stream and at most
**512** command records; each copied command artifact is capped at **4 MiB** (with an explicit
truncation flag), and command-output artifact reads are chunked at **≤ 64 KiB**.

### Sessions

- Sessions pin the **Modal provider/model** configured in the service; `sessions.configure` allows
  only `thinkingLevel` (`off`/`low`/`medium`/`high`) and `instructions`, and rejects any different
  model (`model_pinned`).
- `sessions.fork` requires an `at` entry id (`at` is the string form of a positive safe integer).
  The id is validated through an ownership-scoped read of a single committed entry of **this**
  conversation before any journal write; an unknown or foreign entry id is a structured
  `invalid_params`, never a raw storage error. A fork whose journal never completed fails closed
  with new-`requestId` guidance (no silent duplicate fork). `sessions.reset` is refused unless the
  conversation is idle (`busy`).
- `sessions.steer` / `sessions.followup` require `assignmentId` **and** a `requestId`. Operator
  input is durably tracked: the intent is persisted (`preparing`) **before** it reaches Pi, then
  recorded as `admitted` with its Pi submission id. The same `requestId` + content replays; a
  different content/mode under the same `requestId` is a `conflict`. Input is accepted only while
  an assignment holds a live lease and is **not** closing; otherwise it is refused with guidance to
  start a new assignment (never silently queued). Budget/deadline/lease are shared across every
  input of a run, and a run waits for the primary submission plus **all** tracked inputs (then
  `waitForIdle`) before finalising.
- `sessions.transcript` / `sessions.inspect` are read-only, **byte-bounded** pagination (≤ 256 KiB
  per page) that never skips entries: an entry too large to fit is emitted as a compact summary
  (`truncated: true`, `entryId`) so the caller reconstructs it via `sessions.entry`. Cursors are
  versioned opaque strings bound to the session and scan order; foreign/malformed cursors are
  `invalid_params`. `order` selects `ascending`/`descending`.
- `sessions.entry` streams one entry's redacted JSON in ≤ 64 KiB chunks (`{id, entryId, offset,
  maxChars}`) for full reconstruction beyond the page budget.
- `sessions.tasks` returns **compact** task/submission records (id, kind, state, ownership, status)
  scoped to the session — never a full transcript.
- `sessions.usage` returns the **session's own ledger** with `scope: "session"`;
  `sessions.usageGlobal` returns the service-wide aggregate with `scope: "global"`. Cost fields
  are metadata only and are **not** a GPU/provider bill.
- `sessions.compact` admits a manual compaction task.

### Sandbox / tools

- Tool execution uses macOS `sandbox-exec`. The worker dev network policy `tools.allowNetwork`
  **defaults to `false`** (no network); it is an explicit opt-in and is **separate** from provider
  inference, which always uses the configured Modal provider. There is no silent fallback between
  them.
- The sandbox carves out the assignment scratch directory (nested inside the protected state dir)
  via a `require-all(subpath state)(require-not(subpath scratch))` exception, while config,
  credential, and control-socket literal denies are **never** lifted.

### Durable process receipts & command quarantine

- Every sandboxed command is launched under a **standalone watcher** (`command-supervisor.js`,
  spawned with `process.execPath`, `detached: true`) that owns the command's process **group**. The
  watcher reports the actual command exit code/signal over a **private FD3 newline-JSON** channel
  (≤ 64 KiB/frame, `version: 1`, with `pid`/`pgid` that must EXACTLY match the watcher child).
- **Ordering is a hard invariant:** the "started" process receipt is persisted **synchronously
  through the metadata store BEFORE** `START` is written to the watcher's stdin, so no command can
  run before its durable receipt exists. Teardown (full group reaped) happens **before** the
  "stopped" receipt and **before** the writer lease is freed.
- The watcher transport being `SIGKILL`ed is **cleanup, not command status**. The trusted FD3
  frame preserves exit `0`/`7`; a missing binary is reported as `127`.
- **Group liveness is probed via `kill(-pgid, 0)`** (EPERM ⇒ alive), never a leader-only probe: a
  dead group leader can leave same-PGID children running, and a leader-only probe would wrongly
  free a lease behind a live external command.
- Metadata **schema v6** adds `service_runs` (boot id/pid/clean flag/timestamps) and
  `process_receipts`. A boot is **DIRTY on start** and recorded **CLEAN only after a fully drained
  shutdown** (all tool groups reaped, background settlement awaited) **and** Pi storage closed
  successfully; any failure leaves the boot DIRTY.
- Metadata **schema v7** adds `manager_bindings` (project → manager thread) and `manager_events`
  (the durable wake outbox: dedup key, delivery state, attempts, next-attempt time, acked flag).
  Migration adds both tables to an existing schema-6 db without rewriting existing rows.
- On start, prior DIRTY boots with any command receipt quarantine the affected assignments
  (`state: blocked`, `stopReason: in_doubt_command`, lease **retained**). This blocking is applied
  **before** durable conversations are resumed, so an in-doubt external command is never blindly
  re-run. Startup **never signals a possibly-reused old pgid**; it waits, bounded, for the recorded
  groups to die on their own.
- **Recovery is explicit** (CTO review of checkpoint/diffs), then `assignments.abort` /`recover`
  under a **new bounded assignment**. Aborting a quarantined row with a **live unverified group is
  refused**. Exactly-once external commands are **not** offered and in-doubt commands are **never**
  auto-rerun.
- **Admission gate (authoritative).** Blocking the metadata row alone is *not* sufficient: Pi's
  durable `harness.resume()` re-drives an already-placed submission, and `abortSubmission` cannot
  withdraw it (it returns `already_placed`). Every project tool (`read`/`write`/`edit`/`bash`) is
  therefore wrapped by a **fail-closed admission gate** at the tool-execution boundary. Before any
  side effect it resolves the assignment that currently owns the conversation and refuses the call
  unless that row is `queued`/`running`/`cancelling`, is **not** quarantined in this process, and
  still holds its writer lease. The gate is installed **before** `harness.resume()`, so a re-driven
  in-doubt command is refused even though the model turn itself runs.
- **Conversation/session retirement.** A conversation that **ever** carried an `in_doubt_command`
  assignment is **permanently retired**: its transcript may hold a tool call whose effect was never
  committed, so it must never drive new work. `assignments.submit` reusing a retired session is
  refused (fail-closed, requiring review); `assignments.recover` **refuses to inherit** a retired
  session and starts a **fresh** conversation (callers may pass a fresh `sessionId`). The admission
  gate checks for **any historical** quarantine for the conversation *before* trusting the current
  mapping, and its fallback picks the **current lease-holding / most recent** record — never the
  first historical terminal row — closing the session-reuse ownership edge.
- **Test evidence.** `tests/service-startup-guard.test.ts` drives the **real
  `PiDurableService.start()`** over a `stateDir` seeded by a real `Harness` + `MetadataStore`. A
  clean-boot **control** proves a blind resume appends (marker `PRIMARY\nRESUME\n`, settles
  `needs_review`); the dirty-boot case proves the gate refuses the re-driven call (marker stays
  `PRIMARY\n`, row `blocked`/`in_doubt_command`, lease **retained**), that the quarantined session
  cannot be reused, that explicit `assignments.abort` succeeds once the recorded group is gone, and
  that a fresh assignment then works. It uses only throwaway fixtures — no real manager is stopped
  and no process group is signalled.
- Only **foreground descendants** of a command are managed. Intentionally detached processes
  (double-fork / `setsid` daemons) are **unsupported**; the daemon crash path stops the tool groups
  it owns but cannot reap a deliberately detached process.

## Platform limitations

- **macOS only** is tested. Non-macOS is not validated.
- **Single physical Mac.** Verification was performed on the primary machine only; a **second
  physical Mac** was unavailable, so multi-machine sharing is a **beta limitation** and is not
  validated here.
- **Node >= 22.19.0** is required (the runtime uses native TypeScript type stripping).
- No OpenAI API key or third-party API-manager service is required.
- No MCP dependency and no Decisions integration are present.

## Tests

Run locally with `npm ci && npm run build && npm test`. The suite covers the **service, client,
provider, store, runtime, sandbox, installer, and launcher** modules and runs the **real host
kernel** sandbox where the platform allows. Fixture providers are **synthetic only** and are never
used as a production fallback. Live `sandbox-exec` profile tests and Unix-socket bind probes are
**skipped** inside a nested sandbox and reported honestly as skips (never as passes). Test counts
are reported by the run itself; this file does not assert suite numbers.
