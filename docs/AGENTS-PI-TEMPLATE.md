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

- **Codex owns the roadmap.** Codex maintains the project **roadmap, milestones, dependency order,
  and acceptance criteria** for large (hours-long) projects. Pi workers implement **bounded-SCOPE**
  assignments — a clear, reviewable slice of that plan — which may run for **hours**. "Bounded"
  means the scope is well defined, **not** that the work must fit a fixed time box; do not
  artificially split work to fit an old 20-minute/request cap.

## Delegation rules (only for authorized Pi work)

- Each delegated task is a **bounded-scope assignment** with explicit acceptance criteria.
- **Budgets are unlimited by default.** `limits.maxSteps` and `limits.timeoutMs` are `null` =
  unlimited (omitted also means unlimited); `tools.commandTimeoutMs` is `null` = unlimited for
  normal foreground bash commands. Set a positive finite value only to deliberately bound a run.
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
- Use the explicitly requested saved model profile, otherwise the project choice/default.
  Never silently switch providers or fall back to another endpoint.

## Manager wake and intervention (authorized Pi work only)

The service **itself** observes assignment state changes and durably queues a wake to the Codex GUI
manager thread through the documented `codex queue` CLI — **no GPT polling while the binding is
healthy**. There is no MCP/Decisions/provider change and no LLM in the dispatcher; execution stays
uncapped.

- **Bind a project to a manager thread once**: `manager.bind` with an EXISTING `projectId` and an
  explicit `threadId` (the CLI defaults `threadId` to the caller's `CODEX_THREAD_ID`). Binding
  applies **from now**: historical jobs are not replayed, but an already-running job's future
  terminal state still notifies. Use `manager.unbind` to stop wakes.
- **Read / act / yield**: inspect `manager.events` (project, unacked), act idempotently by event
  id, then `manager.ack` the handled ids. Delivery is **at-least-once**; dedup by event id so
  duplicate wakes never duplicate work. Check `manager.status` for delivery health.
- **Workers ask, they do not guess**: a worker that needs a decision MUST call the
  `request_manager` tool with its `question` (+ optional `context`). That durably records the
  question, **pauses the run safely** (no further code/tool side effects) and wakes the manager —
  it can never retarget another project or thread. The worker never silently guesses or loops.
- **Fallback**: manual `wait` polling is a bounded fallback **only** when the binding is
  unhealthy/an explicit connection problem exists — not the default path.

## Hard limits

- **No subagents.** No commits, pushes, publishes, or deploys. No automated commits.
- Never read secrets or credentials.
- **No MCP and no Decisions integration in this release.** The manager uses no MCP dependency, no
  Decisions integration, and no OpenAI API work: no OpenAI API key is required, and inference uses the user-selected OpenAI-compatible endpoint. Existing Modal settings are preserved.
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
