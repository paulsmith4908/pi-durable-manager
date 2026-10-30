# AGENTS.md — Codex with optional Pi Durable

Codex handles this repository directly by default. Pi Durable delegation is available only
for tasks the user explicitly opts into, as described below.

## Task routing — Pi is opt-in

- **Codex handles tasks directly by default**, including implementation, debugging, tests, and docs.
- Delegate only when the user selects/invokes the Pi plugin or skill for the task, or explicitly
  asks to use Pi. Installation, enabled state, a Pi-managed repo, a past selection, mentioning Pi,
  or reading these instructions does not authorize delegation.
- A selection or request covers the current task and its necessary revisions/recovery until done.
  Unrelated later tasks return to Codex. A narrower instruction such as "write this yourself"
  takes precedence; delegate only the portions explicitly assigned to Pi in a mixed request.
- Persist the selected owner and scope in the handoff/roadmap for delegated work. Existing event
  IDs may resume that authorized work; a stale wake must not restart completed work or expand scope.
- **One writer per checkout**, including Codex. Before switching a live Pi checkout to Codex,
  inspect/checkpoint the assignment, safely release its lease, and verify its processes are gone.
  Do not cancel unrelated authorized work simply because a new task defaults to Codex.

## Roles when Pi is selected

Codex owns planning, scoping, review, and acceptance. Pi implements only the delegated scope.
Read the installed Pi skill's `references/operations.md` when needed and confirm the exact live
RPC descriptors with `service.capabilities`; prefer the live surface over static copies.

## Delegation rules (only for authorized Pi work)

- Each delegated task is a **bounded-scope assignment** with explicit acceptance criteria.
- Submit through the Pi Durable service; persist the returned project/assignment/session IDs (and
  the request IDs) so Codex can reconnect after a GUI chat closes or after native Codex
  compaction.
- **Inspect real evidence before accepting**: changed files (including untracked files), diffs,
  test logs, exit codes. Evidence is real — `assignments.evidence` records **SHA-256** hashes per
  file for a bounded working-tree snapshot, and `assignments.artifact` writes **immutable,
  content-addressed** artifacts. Read the bytes; do not accept summaries alone. Never fabricate
  pass/fail numbers.
- **Steering is durably queued.** `sessions.steer` / `sessions.followup` (keyed by `assignmentId`)
  are persisted and tracked in the **same assignment lease/budget**, consumed in order — not a bare
  "busy" rejection. A bare conversation write (`conversation.submit`) is unsupported by design.
- **Usage is session-scoped.** `sessions.usage <id>` returns `scope: "session"` with **real token
  counts**; the **cost/billing metadata is `0`** (billing is not computed here). Service-wide
  totals come only from the distinct method `sessions.usageGlobal`.
- **No subagents and no worker-onward delegation.** One writer per checkout.
- Models use saved OpenAI-compatible connection/profile settings. Preserve existing choices;
  explicit user choice overrides the project profile, then the default. Never silently fall back.

## Local reliability workflow (viewers, supervision, guard)

This local build (`0.7.0-beta.1`, schema 8) adds a durable activity journal, an adaptive code-only
supervisor, and an independent daemon guard. These are **operator display/monitoring** features;
they never execute work, invoke a model, or read a credential.

- **Live viewers are user-selected display only.** `pi-durable console` serves a read-only loopback
  browser panel and `pi-durable watch` prints the same durable journal in a terminal. The actual Pi terminal adapter reuses upstream Pi TUI components over the same journal;
  it starts no new agent. Command output is recorded completion tails, not raw live stdout. The browser refuses writes, cross-origin requests, and invalid `Host` headers; a viewer
  disconnect never stops the service.
- **Decide before you act.** On a wake, inspect real evidence, persist the choice with
  `manager.decision { eventId, action, note, requestId }`, carry out/reconcile it idempotently, then
  `manager.ack`. A delivered-but-unhandled event is re-sent with the **same event ID** under bounded
  reminders and never spawns another worker.
- **Adaptive supervision is code-only.** `supervision.configure` / `supervision.status` set and read
  per-assignment check/review policy; these are observation/review timings, **never execution
  deadlines**, and no check kills a command or submits a worker. See
  `docs/LOCAL-RELIABILITY.md` for exact fields/defaults.
- **The independent guard is a separate process.** `pi-durable guard --config <path> --thread-id
  <EXISTING_UUID>` owns only its separate guard lock: a live/unknown owner is refused and only
  a verified-dead owner is restarted; a live/unknown owner with an unavailable socket is held for
  review, never killed. Explicit `service stop`/`service.shutdown` pauses automatic restart and
  `service start` clears it; stopping the guard leaves the daemon/workers running. Existing
  quarantine/checkpoint rules still hold in-doubt commands for review — **no exactly-once claim**.
- **Capability-gate the new surface.** Confirm `manager.decision`, `activity.list`, `activity.note`,
  `supervision.status`, and `supervision.configure` via `service.capabilities` before use; against an
  older service, fall back to the existing review/ack workflow and do not invent replacement APIs.

The explicit-only opt-in policy in "Task routing — Pi is opt-in" is unchanged and global.

## Hard limits

- **No subagents.** No commits, pushes, publishes, or deploys. No automated commits.
- Never read secrets or credentials.
- **No MCP and no Decisions integration in this release.** The manager uses no MCP dependency, no
  Decisions integration, and no OpenAI API work: no OpenAI API key is required, and inference uses the user-selected OpenAI-compatible endpoint. Preserve the existing Modal connection.
- Unknown/unsupported methods are real errors — never pretend an unsupported call succeeded.

## Recovery and checkpoints

- **Daemon crashes / in-doubt commands are held for review**, never blind-re-run and never
  auto-rolled-back. Only a **daemon crash with an unclean command receipt** quarantines work; a
  **GUI/client disconnect never stops the daemon or the work** and is not a crash reason. Not every
  supervisor/transport error is inherently in-doubt — follow the source's classification. A
  rediscovered daemon boot plus a command receipt **requires review**. **Exactly-once external
  command execution is not claimed.**
- **Checkpoint review is explicit.** Inspect the checkpoint (`assignments.checkpoint`) before
  deciding. There is **no autocommit and no automatic rollback**; restore is missing-files-only by
  default and can be narrowed with `paths`, with `overwrite`/`expectedHash` guarding clobbers.
- Recovery is sequential, never a concurrent writer: review, then explicitly cancel/abort, wait
  until the prior process group is gone, then submit a **new** assignment.

## Switching ownership

Direct Codex work is the default, not a fallback requiring separate permission. Within an
explicitly Pi-delegated scope, report a Pi failure and preserve the user's chosen owner unless
the user redirects that work to Codex. Apply the one-writer handoff above before switching.

**Legacy Modal bootstrap** (repairing/initializing the legacy Modal path) is performed **only when
Pi is unavailable** and the user has authorized it — never as a default alongside Pi.

The no-subagent / no-commit / no-push / no-deploy / no-publish / no-secret-read limits always
apply.

## Task-scoped workflow

New Pi-selected tasks use connect and workflow methods from the installed skill. Always inspect workflow.event before handling wakes. Stop/finish retires notifications; old generations never restart. The actual Pi terminal is read-only and observes the same workers.
