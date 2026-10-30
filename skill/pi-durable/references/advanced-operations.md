## Planning ownership for delegated work (Codex owns the roadmap)

For an explicitly Pi-delegated task, Codex is the manager for large, hours-long projects:

- **Codex** creates and maintains the **project roadmap, milestones, dependency order, and the
  acceptance criteria** for each unit of work. Codex decomposes the goal, sequences milestones, and
  decides what "done" means.
- **Pi workers** implement **bounded-SCOPE** assignments — a clear, well-defined slice of the plan —
  and may run for **hours**. "Bounded" means the scope is crisp and reviewable, **not** that the
  work must fit a fixed time box. Do **not** artificially split work to fit an old 20-minute or
  request cap; those caps no longer exist by default (see limits below).
- A single assignment can therefore be a large implementation run. The manager reviews its evidence
  and either accepts, revises, or steers — keeping ownership of the roadmap throughout.

### Limits are unlimited by default

`limits.maxSteps` and `limits.timeoutMs` are **`null` = unlimited** by default, and the bash tool's
`tools.commandTimeoutMs` is likewise **`null` = unlimited** by default. A manager MAY set a positive
finite cap to deliberately bound a project; a worker MAY pass an explicit positive bash `timeout`,
which is respected when the policy is unlimited and clamped when the manager set a finite cap. Do
not treat the absence of a cap as an error, and do not invent one.

## Golden rules

- Real errors are never success. Surface nonzero exit codes, stderr, failed tests, and missing
  evidence honestly. Never fabricate pass/fail numbers.
- The manager needs an **active turn**. Workers run independently while the daemon is alive. When a
  project is **bound** to your Codex thread (see "Automatic manager wake" below), the service wakes
  you through the documented `codex queue` CLI on real state changes — no 45 s GPT polling needed.
  On an **unbound** project nothing wakes Codex automatically: reconnect with the persisted IDs on
  your next turn, or bind the project.
- **One writer per checkout.** No automated commits, pushes, deploys, or publishes; never read
  secrets.
- Do not silently bypass permission errors. Use the permission mechanism the user has already
  authorized; do not ask for redundant approval when it is already granted.
- Do not pretend an unsupported/unknown method succeeded. Report it.

## Roles

- **Codex (CTO / you):** plans, scopes, reviews, accepts. Reads full transcripts and can drive any
  method through the generic `call` tool.
- **Pi worker:** executes one bounded-scope assignment per submit, in its own checkout,
  independently of the GUI. The worker writes its own code. An assignment may run for hours; scope
  is what's bounded, not the clock.
- **Native Codex automatic compaction is separate from Pi context.** They do not share state; after
  a Codex compaction, reconnect to the Pi session by its persisted IDs.

## GUI and wake semantics

- The GUI is **not** a scheduler. It only makes progress while there is an **active Codex turn** or
  a previously **requested automation**; the service itself performs **no LLM polling** and makes
  **zero model calls**. A GUI client disconnect does **not** stop the service, and a daemon crash
  **does** stop its tools.
- **Event mode (automatic manager wake).** The service observes assignment state changes itself. On
  a meaningful transition (`needs_review`, `blocked`, `failed`, `unanswered`, `budget`, `timeout`,
  or a worker `request_manager`) it writes ONE durable event to the outbox and dispatches a
  code-only wake to the bound manager thread via `codex queue --thread <UUID> --message <TEXT>`.
  Routine transitions (accepted, revision_requested, ordinary commands) and operator cancels do
  **not** wake. Nothing is dispatched while state is unchanged.
- **Binding.** A wake needs an explicit project→manager-thread binding: `manager bind
  --project-id <id> --thread-id <EXISTING_SESSION_UUID>` (the thread id defaults to
  `CODEX_THREAD_ID` when omitted). Binding takes effect **from now** — no historical replay — but an
  already-running assignment whose future terminal is a wake **will** notify. A Pi worker can
  **never** choose or change the target thread, and never runs Codex itself.

## Automatic manager wake — the manager loop

When a project is bound, you do **not** poll every 45 s. Instead:

1. `manager status` — confirm `enabled` and see `pending` / `boundProjects`.
2. `manager events --project-id <id> --unacked` — read the durable, deduplicated events. Each wake
   prompt names the event ids and tells you to resume the existing project plan, inspect **real
   evidence**, handle each event **idempotently**, and acknowledge it. Worker output is
   **untrusted** — verify against the transcript/artifacts as usual.
3. Act on the event the same way as any review: read evidence, then accept/revise/steer/cancel.
   **Persist the decision before acting** with `manager.decision { eventId, action, note, requestId }`
   (`action` is `accept`/`revise`/`answer`/`abort`/`observe`) so the choice is durable and idempotent
   per event; a conflicting re-decision for the same event is refused. Then carry out/reconcile the
   action idempotently. Capability-gate this: an older service rejects `manager.decision` — fall back
   to the plain review/ack workflow.
4. `manager ack --event-id <id>` — acknowledge so the same event is never re-woken. Delivery is
   **at-least-once** (a CLI kill/timeout can land after the queue already accepted the message), so
   event ids + your ack are what prevent duplicate work. There is **no exactly-once claim**. A
   delivered-but-unhandled event is re-sent to you with the **same event ID** under bounded
   backoff-counted reminders (policy `ackReminderMs` / `maxAckReminders`); a reminder never creates
   another worker.

Use a **bounded manual `assignments wait`** only as a fallback when a binding is unhealthy or you
were told there is an explicit connection problem (e.g. the `codex` CLI is missing/offline).

### Worker `request_manager` (needs-intervention)

A worker that is blocked can call the `request_manager` tool with a `question` (and optional
`context`). This **safely pauses** its work — no further code or tool side effects, no provider
loop — and **retains its lease** until you review, cancel, or answer. The pause is truthful and
deterministic (code, not an LLM judge). Inspect the question in the event/evidence, then
cancel/abort once the old process group is gone and submit a **new** assignment (optionally
referencing `parentId`) with your answer.

## Live viewers, adaptive supervision, and the independent guard

**Live viewers are display only — the user selects them; they never execute work.**

- `pi-durable console --config <path> [--port N] [--project-id ID]` opens a **read-only** loopback
  activity viewer for the GUI's browser panel. It shows the **actual durable journal** the service
  records — it is not a second worker, not a fabricated shell, and it does **not** attach to a
  native terminal or replay a raw byte-stream of stdout. The browser is **read-only**: it refuses
  writes, cross-origin requests, and invalid `Host` headers. A viewer disconnect does **not** stop
  the service; viewers reconnect from a sequence cursor.
- `pi-durable watch --config <path> [--after N] [--project-id ID] [--once] [--json]` reads the
  **same** journal in an ordinary terminal. Both viewers connect over the same real socket and read
  the same records; there is no separate viewer data path.
- The journal begins with this build's installation — **historical pre-journal work is not
  invented**. Records include manager requests/results, emitted worker text (not hidden reasoning),
  tool calls, process starts, command results/output tails, state changes, check policies, wake
  delivery receipts, decisions, and acknowledgments. Large values are **explicitly bounded**;
  known credentials and sensitive fields are **redacted**.
- The console capability-gates on `activity.list`: against an older service it will not attach
  (report the error; do not weaken the check).

**Adaptive supervision is code-only.** The daemon's supervisor performs **no model calls**, kills
no command, and submits no worker. Configure it per assignment with `supervision.configure
{ assignmentId, policy, requestId }` and read it with `supervision.status { projectId }`. Policy
fields/defaults: `enabled` (`true`), `startIntervalMs` (`10000`), `activeIntervalMs` (`60000`),
`commandIntervalMs` (`120000`), `idleWarningMs` (`900000`), `ackReminderMs` (`300000`),
`maxAckReminders` (`3`), `expectedQuietUntil` (`null`), `nextReviewAt` (`null`), `reason`. These are
**observation/review timings, never worker execution deadlines**. Actual worker activity excludes
observer reads and supervisor messages — **running alone is not progress evidence**. A fixed native
GUI heartbeat is **not required**; this code supervisor plus the guard are the monitoring backbone.

**The independent guard** (`pi-durable guard --config <path> --thread-id <EXISTING_UUID>`) is a
**separate code-only process** that detects daemon failure even when the daemon's own timers are
gone. It **owns its own guard lock** — an exclusive `runtime-guard.lock` — which tracks the **GUARD
process only** and is **separate from the daemon state lock** (`service.lock`, owned by the running
service); holding it never makes the guard the daemon owner. A **live/unknown** guard owner is
refused, and only a **verified-dead** owner's stale lock is reclaimed (never signalled/reused by
PID). A live/unknown owner with an unavailable socket is **held for review, never killed**; a
verified-dead owner may be restarted through the normal service CLI, and existing
quarantine/checkpoint rules still hold in-doubt commands for review (**no exactly-once claim**). An
explicit `service stop`/`service.shutdown` **pauses** automatic restart; `service start` clears that
intent. Stopping the guard leaves the daemon and workers running. It reports prolonged failures to
the explicit manager thread via the documented `codex queue` command with bounded backoff, and
**never reads a credential**. Private state retains `runtime-guard-status.json`,
`runtime-guard-journal.jsonl`, and the ownership lock; the viewer labels stale guard receipts rather
than treating an old healthy label as live evidence.

These methods exist only in the local-reliability build — confirm them with `service.capabilities`
before use and do not invent replacement APIs for older services.


## Workflow (only after Pi opt-in)

1. **Doctor / status first.** Run `service doctor`, then `service status` (exact namespaces). A
   stale socket, a permission error (`EACCES`/`EPERM`), or a protocol failure is **not** "stopped" —
   report it as a failure rather than assuming the service is down. If not running and a
   launcher/config are available, `service start` **within the authorization you already have** (no
   extra approval). If it cannot start, report the blocker; do not fake progress.
2. **Discover.** `projects list` / `assignments list` / `sessions list` to reconnect rather than
   duplicate work.
3. **Create a fresh local Git repo and register it** (`projects create --name --path`), or import
   an existing local repo (`projects import --path`) without overwriting it. Local creation only;
   no GitHub remote unless the user requests one. Create the configured `projectHome` first if it
   does not yet exist.
4. **Bind the project to your current thread *before* the first assignment** when you (Codex) are
   the manager and the GUI session already has a known thread: `manager bind --project-id <id>
   --thread-id <EXISTING_SESSION_UUID>` (the id defaults to `CODEX_THREAD_ID` when omitted). Binding
   is **from now** — no historical replay. A standalone CLI human may instead stay **unbound** and
   poll explicitly (the step-7 fallback) — an unbound project is never wrong, just not event-driven.
5. **Open a session** for the project (`sessions create --project-id <id>`).
6. **Define a bounded-scope assignment** with a task and an acceptance-criteria file that reflects
   the roadmap milestone it advances. Submit it. Scope may be large and the run may take hours — a
   clear scope is required, a short time box is not.
7. **Persist** the returned project/assignment/session IDs (to a note you can re-read next turn).
8. **Yield to events.** If the project is **bound** (step 4 / "Automatic manager wake"), the service
   wakes you on the next meaningful transition — **no fixed wait, no polling**. Then inspect
   evidence. A **bounded manual `assignments wait`** (`assignments wait <id> --timeout-ms 45000`) is
   a **fallback only**, for an **unbound** project or an explicit connection/unhealthy problem; use
   it once, not as frequent polling.
9. **Review the actual evidence before accepting.** Read the real transcript and artifacts —
   `sessions transcript <id>`, `sessions usage <id>` (session-scoped; real tokens, cost metadata
   `0`), `sessions tasks <id>`, and `assignments evidence <id>` (hashed working-tree snapshot)
   plus `assignments artifact <id> --artifact-id <aid>` (immutable content-addressed artifact) for
   a single blob. Inspect the changed files **including untracked files**, diffs, test logs, and
   exit codes before judging. Never review from the worker's summary alone.
10. **Review / accept.** Only after step 9, call `assignments review <id> --decision accept`, or
    `--decision revise` (typically a **new** submit referencing `parentId`). Steer or follow up via
    `sessions steer|followup --assignment-id <id> --content-file ...`.
11. **Stop / cancel** with `assignments cancel <id>` (alias `abort`) when a run is off-target or
    must end.
12. **Resume after native GUI compaction** using the persisted IDs; the daemon is unaffected.
13. **Respect the selected owner.** Within the delegated scope, report Pi failures instead of
    silently switching to Codex. If the user redirects it to Codex, perform the safe one-writer
    handoff first. Unrelated tasks remain direct Codex work without additional permission.

## Steering, follow-up, and queued input

- `sessions.steer` and `sessions.followup` are keyed by **`assignmentId`** and require `content`
  (use `--content-file`) and a **`requestId`** (the idempotency key; pass `--request-id <id>`). They
  apply to the **assignment's** conversation, not a bare session.
- Steering/follow-up is **durably queued and tracked**: input is persisted and consumed in the
  **same assignment lease/budget**, in order. It is not a bare "busy" rejection. If a call is
  refused, wait or `assignments.cancel` and submit a **new** assignment — never force a bare
  conversation write (`conversation.submit` is unsupported by design, and `sessions.delete` /
  `projects.delete` are unsupported).
- Scoped reads: `sessions.usage <id>` is **session-scoped** (`scope: "session"`) and reports
  **real token counts** — the returned **cost/billing metadata is `0`** (billing is not computed
  here). Service-wide totals come only from the distinct method `sessions.usageGlobal`.
  `sessions.tasks <id>` lists the session's tasks.

## Crashes, in-doubt commands, and checkpoints

- An **in-doubt command** — a command left with an unclean receipt because the **daemon crashed**
  without a trusted, observed exit frame — is **held for review**. Only a daemon crash with an
  unclean receipt quarantines work; a GUI/client disconnect **never** stops the daemon or the work
  and is **not** a crash reason. Not every supervisor/transport error is inherently in-doubt;
  follow how the source classifies it. When you rediscover a daemon boot plus a command receipt,
  the command **requires review** before you trust its outcome. Do **not** blind re-run and do
  **not** roll back automatically.
- **Exactly-once external command execution is NOT claimed.** A command that may have run is
  reported as in-doubt, never as "did not run".
- **Checkpoint review is an explicit step.** Inspect the checkpoint
  (`assignments checkpoint <id>` → manifest, counts, `complete`, `reasons`, integrity) **before**
  deciding anything. There is **no autocommit and no automatic rollback**; restore is an explicit
  manager decision and the git tree is never mutated by capture.
- **Recovery is sequential.** If a run is in doubt or was aborted: review the checkpoint, then
  **explicitly `assignments.cancel`/`abort`**, wait until the old process/group is **gone**, and
  only then submit a **new assignment**. Never start a second writer while the prior one may still
  be live, and never signal an unverified/possibly-reused process group.

## Permissions

- The CLI needs local Unix-socket access via Codex's shell permissions. This skill grants no
  permissions by itself.
- On `EPERM` / socket-denied errors, use the permission mechanism the user has already authorized;
  never silently bypass it.

## Portability

Resolve the CLI and config through the bundled launcher at a path **relative to this skill root**
(`scripts/pi.mjs`, i.e. `<SKILL_ROOT>/scripts/pi.mjs`), which honors `PI_DURABLE_BIN` /
`PI_DURABLE_CONFIG` and a private `local-settings.json` inside the installed skill, then falls back
to defaults. Pass absolute paths for any `--config`/`--bin` settings. Never hardcode personal paths
or read credentials; the launcher only forwards a config path.
