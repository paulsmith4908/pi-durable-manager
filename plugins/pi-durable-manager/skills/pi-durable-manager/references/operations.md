# Pi Durable — CLI & RPC reference

The CLI is a thin client over the local Unix-socket service. Reach it through the bundled
launcher: `node <SKILL_ROOT>/scripts/pi.mjs <args...>` (see `../scripts/pi.mjs`). The launcher
forwards argv to the resolved CLI and sets the config path; it never reads credentials.

For the exact implemented surface and platform limits, see `docs/IMPLEMENTED.md`.

## Global shape

```
pi-durable call <method> [--params-file FILE|-] [--request-id ID] [--config PATH] [--json]
pi-durable <namespace> <action> [args...] [--params-file FILE] [--json]
pi-durable service <start|stop|status|doctor> [--config PATH] [--json]
pi-durable config check <path> [--json]
pi-durable check --offline [--json]
pi-durable check --online --thread-id <UUID> [--config PATH] [--json]
pi-durable check --verify <RUN_ID> [--config PATH] [--json]     # re-open a run; never re-runs, never acks
pi-durable serve --config PATH [--socket PATH]     # run in the foreground
```

- Flags may appear **anywhere** (before, between, or after command tokens).
- Namespace helpers accept **singular or plural**: `project`/`projects`, `session`/`sessions`,
  `assignment`/`assignments`, `manager`/`managers`. There is **no** `usage` namespace — service-wide
  usage is the distinct protocol method **`sessions.usageGlobal`** (call it generically; it has no
  named helper — see below).
- **Exit codes**: `0` success, `1` runtime failure (redacted error), `2` usage error.
- With `--json`, stdout is exactly one envelope: `{"ok":true,"result":...}` or
  `{"ok":false,"error":{"code","message"}}`. stdout is data; diagnostics go to stderr.

### Param flags

Scalar flags copied into `params`: `--project-id`, `--session-id`, `--parent-id`, `--id`,
`--name`, `--path`, `--decision`, `--note`, `--limit`, `--cursor`, `--order`, `--assignment-id`,
`--thread-id`, `--event-id`.

Bare boolean flags: `--overwrite`, `--allow-legacy`, `--unacked`.

File flags (contents read as bounded UTF-8, <= 1 MiB -> `task`/`criteria`/`content`):
`--task-file`, `--criteria-file`, `--content-file`.

`--timeout-ms` bounds the **client wait** for `assignments.wait` (capped at 60s). It has nothing to
do with the assignment's execution budget — see *Budget limits* below. `--params-file FILE` (or `-`
for stdin) supplies a base JSON object; unknown flags are a usage error.

## Budget limits (unlimited by default)

An assignment's execution budget is **unlimited by default** and is **independent** of any client
wait:

- `limits.maxSteps` (`null` = unlimited): the maximum number of provider requests for the
  assignment. Unlimited runs do not trip a step budget and the step counter stays accurate.
- `limits.timeoutMs` (`null` = unlimited): a wall-clock deadline. Unlimited runs persist
  `deadlineAt: null` and never arm an assignment-deadline timer.
- `tools.commandTimeoutMs` (`null` = unlimited): a cap on a normal foreground bash command. When
  `null`, a command runs to completion unless the worker passes its own positive finite `timeout`
  (which is respected); when the manager sets a finite cap, the worker's `timeout` is clamped to it.

A manager MAY set any of these to a positive finite value to bound a project; omitted and `null`
both mean unlimited. `contextWindow`/`maxTokens` remain **finite generation constraints** and are
independent of these budgets. `assignments.wait` remains a **bounded** client/server wait (≤ 60s)
regardless of the assignment budget.

## Service lifecycle

| Command | Params | Notes |
| --- | --- | --- |
| `service start` | — | Detached daemon; readiness verified against its own pid. |
| `service stop` | — | Sends `service.shutdown`, waits for the socket to vanish. |
| `service status` | — | Read-only; `running`/stopped plus a `code` (`no_socket`, `stale_socket`, `permission`, `protocol_error`, `unreachable`). A stale socket or permission/protocol failure is **not** a clean stop and exits non-zero. |
| `service doctor` | — | Read-only env check; works even if config is unreadable, but an **invalid** config yields `ok:false` / exit 1. |

`config check <path>` validates a config and prints provider id, model, endpoint, limits, and
credential **reference form** (`apiKeyFile` or `env`) — never the secret itself. An `apiKeyFile` is
validated **by metadata only** — regular file, **not** a symlink (never followed), owner-only mode
(`0600`); the **bytes are never read**, so a raw key pasted into the path is never displayed. A
directory/symlink/world-readable file is a **FAIL**; a missing file is a **WARN**.

## Checks (`check`) and honest verdicts

`check --offline` runs an isolated fixture (no real inference). `check --online` performs real
inference + a code-only wake and is **manager/human-initiated**; it requires an explicit manager
thread UUID.

- **Durable receipt first.** The run receipt is persisted atomically (0600) **before** any
  project/session/bind/assignment call. If it cannot be persisted, the check **exits non-zero and
  submits nothing**; a later write failure is reported truthfully with the recoverable `requestId`
  and known IDs (redacted) and is **never re-submitted**.
- **Verdict.** PASS requires assignment `accepted` **+** wake event `delivered` **+** event acked.
  Running/queued/pending/parked/unacked is **PENDING**; failed/unanswered/cancelled/unknown or a
  missing id is **FAIL**. The event receipt reads the **actual** `deliveryState`/`acked` from
  `manager.events` — an existing row is never assumed `delivered`. The check **never auto-accepts**
  an assignment and **never acks** a live event.
- **Verify.** `check --verify <RUN_ID>` re-opens a persisted run (never re-runs, never acks) and
  applies the same verdict, reading the **direct** shape returned by `assignments.show`. Use it
  **after a real review**. An unknown run id is a usage error (exit 2).
- **Service compatibility.** `--online` strictly validates package version, protocol, state dir,
  config path, provider id (`modal`) and model; on mismatch or an unreadable status it **stops
  before creating any project** and never stops your daemon. `service version` reports the installed
  package version + protocol.

## Projects

| Method (`call`) | Helper | Params |
| --- | --- | --- |
| `projects.create` | `projects create` | `name`, `path` (fresh local Git repo; **parent must exist**) |
| `projects.import` | `projects import` | `path` (+ optional `name`); existing repo, in place |
| `projects.list` | `projects list` | — |
| `projects.show` | `projects show <id>` | `id` |

## Sessions

| Method (`call`) | Helper | Params |
| --- | --- | --- |
| `sessions.create` | `sessions create` | `projectId` |
| `sessions.list` | `sessions list` | optional `projectId` |
| `sessions.inspect` | `sessions inspect <id>` | `id` (transcript + usage) |
| `sessions.transcript` | `sessions transcript <id>` | `id`, optional `order`, `limit`, `cursor` |
| `sessions.tasks` | `sessions tasks <id>` | `id` |
| `sessions.usage` | `sessions usage <id>` | `id` — **session-scoped** usage (`scope: "session"`) |
| `sessions.usageGlobal` | *(call only)* | none — **service-wide** aggregate (`scope: "global"`); no named helper, use `pi-durable call sessions.usageGlobal` |
| `sessions.fork` | `sessions fork <id>` | `id`, **`at`** (entry id; required) |
| `sessions.compact` | `sessions compact <id>` | `id`, optional `instructions` |
| `sessions.configure` | `sessions configure <id>` | `id`, `thinkingLevel` and/or `instructions` |
| `sessions.reset` | `sessions reset <id>` | `id`, optional `handoff`; requires idle |
| `sessions.entry` | `sessions entry <id>` | `id`, `entryId`, optional `offset`, `maxChars` (stream one redacted entry in ≤64KiB chunks) |
| `sessions.steer` | `sessions steer` | **`assignmentId`**, **`content`**, **`requestId`** |
| `sessions.followup` | `sessions followup` | **`assignmentId`**, **`content`**, **`requestId`** |

`sessions.usage <id>` is **session-scoped** (`scope: "session"`) and returns **real token counts**
for that session; the **cost/billing metadata is `0`** (not computed here). Service-wide totals are
the **separate, explicit** protocol method **`sessions.usageGlobal`** (`scope: "global"`).

- `sessions.configure` is pinned to that session's saved model profile; a different `model` is rejected
  (`model_pinned`). `thinkingLevel` is `off`/`low`/`medium`/`high`.
- `sessions.reset` is refused unless the conversation is idle (`busy`); abort the assignment first
  to stop in-flight work.
- `sessions.fork` requires `at` (a visible entry id); omitting it is an error.

## Assignments

| Method (`call`) | Helper | Params |
| --- | --- | --- |
| `assignments.submit` | `assignments submit` | `projectId`, `task`, `requestId`, optional `criteria`, `sessionId`, `parentId` |
| `assignments.create` | — | alias of `assignments.submit` |
| `assignments.show` | `assignments show <id>` | `id` or `requestId` |
| `assignments.inspect` | `assignments inspect <id>` | alias of `assignments.show` |
| `assignments.list` | `assignments list` | optional `projectId` |
| `assignments.wait` | `assignments wait <id>` | `id`, optional `timeoutMs` |
| `assignments.abort` | `assignments abort <id>` | `id` |
| `assignments.cancel` | `assignments cancel <id>` | alias of `assignments.abort` |
| `assignments.review` | `assignments review <id>` | `id`, `decision` (`accept`/`revise`), optional `note` |
| `assignments.recover` | *(call only)* | `id`, optional `requestId` (reconcile/reattach a running assignment's tracked inputs after restart) |
| `assignments.evidence` | `assignments evidence <id>` | `id`, optional `allowLegacy` |
| `assignments.artifact` | `assignments artifact <id>` | `id`, `artifactId`, optional `offset`, `maxChars` |
| `assignments.checkpoint` | `assignments checkpoint <id>` | `id` (inspect: manifest, counts, `complete`, `reasons`) |
| `assignments.restore` | `assignments restore <id>` | `id`, optional `requestId` (idempotency key; auto-generated `restore-<id>-<ts>` when omitted, or set via generic `--request-id`), optional `paths` (relative paths to restore), optional `overwrite` (default `false` = missing files only), optional `expectedHash` (per-path hash map guarding a stale/violated overwrite). Restore skips existing files unless `overwrite` is set; a differing `expectedHash[path]` is reported as a conflict and left untouched. |

The `requestId` is the idempotency key: the same `(requestId, payload)` replays; a different
payload under the same id is a `conflict`. `--request-id ID` sets it explicitly. `assignments.restore`
reads `id`, optional `requestId` (auto-generated when omitted), and optional `paths`/`overwrite`/
`expectedHash`, which are passed as JSON via `--params-file` (there are no dedicated CLI flags for them).

Boolean params are bare flags: `--overwrite` (opt into clobbering existing files on restore) and
`--allow-legacy` (return a raw legacy evidence summary). `--overwrite=false` sets it explicitly
false. Numeric params (`--offset`, `--max-chars`) must be finite numbers. Restore path filtering
and stale-overwrite guards are passed as JSON via `--params-file` (`paths`, `expectedHash`);
do not invent flags that are not in the method params.

### Bounded waits (fallback only)

`assignments.wait` is a **fallback** for an **unbound** project or an explicit connection/unhealthy
problem — with a healthy binding you **yield to events** (see "Automatic manager wake") and do not
poll on a fixed timer. When you do use it, `--timeout-ms` is forwarded to the server as
`params.timeoutMs` **and** sizes the client wait to `requested + 5s` (capped at 65s) so the server —
which caps waits at 60s — always replies before the client gives up:

```sh
node <SKILL_ROOT>/scripts/pi.mjs assignments wait <assignmentId> --timeout-ms 45000 --json
```

A wait bound supplied via `--params-file` is honoured client-side as well:

```sh
cat > wait.json <<'JSON'
{ "id": "<assignmentId>", "timeoutMs": 45000 }
JSON
node <SKILL_ROOT>/scripts/pi.mjs call assignments.wait --params-file wait.json --json
```

## Notable behaviors

- **`service.capabilities` returns method descriptors**, not just bare names: each entry carries the
  method name plus its descriptor (params/behavior metadata). It is the machine-readable surface —
  use it instead of inventing a `describe` command.
- **Steering and follow-up are durably queued.** `sessions.steer` / `sessions.followup` are
  **tracked in the same assignment lease/budget** as the running work: input is persisted and
  consumed in order, not merely refused while a table is busy. There is no `inprogress` state to
  poll; if a call is refused, fall back to `assignments.cancel` and a **new** assignment rather than
  forcing input.
- **`conversation.submit` is unsupported by design.** A bare conversation write would bypass the
  assignment lease/budget; use `sessions.steer` / `sessions.followup` (with an `assignmentId`) or
  a new assignment. `sessions.delete` / `projects.delete` are also unsupported.
- **`sessions.usage <id>` is session-scoped** (`scope: "session"`) and reports **real token counts**
  for that session; the returned **cost/billing metadata is `0`** because billing is not computed
  here. Service-wide totals come only from the distinct method `sessions.usageGlobal`. `sessions.tasks <id>`
  lists the session's tasks.
- **Evidence is the actual transcript/logs, with hashed snapshots and immutable artifacts.**
  Inspect the real transcript and logs **before** `assignments.review --decision accept`. Use
  `assignments evidence <id>` (hashed working-tree snapshot: `sha256` per file, changed/untracked
  detection) and `assignments artifact <id> --artifact-id <aid>` (immutable, content-addressed
  artifact; optional `--offset`, `--max-chars`) to read the real bytes. Hashing and immutable
  artifacts **are implemented**; rely on the recorded digests.
- **Daemon crashes and in-doubt commands are held for review.** Only a **daemon crash with an
  unclean command receipt** — the daemon stops without a trusted, observed exit frame — can leave a
  command `in_doubt`, and that command is **quarantined for review**, never blind-re-run and never
  auto-rolled-back. A GUI/client disconnect **never** stops the daemon or the work: it is **not** a
  crash reason and produces no quarantine. Not every supervisor/transport error is inherently
  `in_doubt` — follow how the source actually classifies it rather than assuming. When you
  rediscover a daemon boot plus a command receipt, treat the command as **requiring review** before
  trusting its outcome. **A permanent `in_doubt` session is retired and MUST NOT be reused:** after
  an `in_doubt` outcome, start a **fresh session** (`sessions.create`) and re-issue the work there
  rather than resuming or steering the retired session. **Exactly-once external command execution is
  NOT claimed.**
- **Checkpoint review is explicit.** Inspect the checkpoint (`assignments checkpoint <id>`) —
  manifest, counts, `complete`, `reasons` — before deciding. There is **no autocommit and no
  automatic rollback**. Recovery is sequential: review the checkpoint, then explicitly
  `assignments.cancel`/`abort`, wait until the prior process/group is **gone**, and only then submit
  a **new** assignment. Never signal an unverified/possibly-reused process group.
- **The service does not schedule LLM turns.** It advances while there is an **active Codex turn**
  or a previously **requested automation**, and it makes **zero model calls / no LLM polling**. When
  a project is **bound** to a manager thread, the service wakes Codex via the documented
  `codex queue` CLI on meaningful state changes (see *Automatic manager wake* below); on an unbound
  project there is no automatic wake. A GUI client disconnect does **not** stop the service; a
  daemon crash **does** stop its tools.
- Unknown methods are real errors (`method_not_found`); never pretend an unsupported call
  succeeded.

## Automatic manager wake (event mode)

The service runs a code-only outbox/dispatcher: on a meaningful assignment transition it writes ONE
durable, deduplicated event to the outbox (same MetadataStore SQLite, single writer) and dispatches
a wake to the bound manager thread. **No LLM is involved and nothing is dispatched while state is
unchanged.** Delivery is **at-least-once** — a CLI kill/timeout can land after the queue already
accepted the message — so event ids + your ack prevent duplicate work. There is **no exactly-once
claim**.

Wake kinds: `needs_review`, `blocked`, `failed`, `unanswered`, `budget`, `timeout`, `manager_request`.
Routine transitions (`accepted`, `revision_requested`, ordinary commands) and operator cancels do
**not** wake.

| Method (`call`) | Helper | Params |
| --- | --- | --- |
| `manager.bind` | `manager bind` | `projectId`, `threadId` (defaults to `CODEX_THREAD_ID`), optional `requestId` |
| `manager.unbind` | `manager unbind` | `projectId` |
| `manager.list` | `manager list` | — |
| `manager.status` | `manager status` | optional `projectId` (`enabled`, `pending`, `boundProjects`) |
| `manager.events` | `manager events` | `projectId`, optional `unacked` (bare flag), `limit` |
| `manager.ack` | `manager ack` | `eventId`, optional `requestId` |
| `manager.decision` | *(call only)* | `eventId`, `action` (`accept`/`revise`/`answer`/`abort`/`observe`), `note`, `requestId` — idempotent per `eventId`; a different `(action, note)` for the same event is a `conflict` |

### Decisions, adaptive checks, and the independent guard

A wake is **information, not authorization to act blindly**. The reliability workflow is:

1. `manager.events --project-id <id> --unacked` — read the durable events (ids + summaries only).
2. Inspect the **real evidence** for each event (`assignments evidence`, transcript, logs, exit codes).
3. Persist the decision **before** acting: `manager.decision { eventId, action, note, requestId }`.
   This is idempotent per `eventId`; replaying the same `(action, note)` returns the stored decision,
   and a conflicting re-decision is refused. Older services reject the call — capability-gate it.
4. Carry out / reconcile the action (accept, revise, answer, abort, or observe) **idempotently**.
5. `manager.ack --event-id <id>` — acknowledge so the same event is never re-woken.

`activity.list` / `activity.note` are the **durable redacted journal** the live viewers read:

| Method (`call`) | Params | Notes |
| --- | --- | --- |
| `activity.list` | `after`, `limit` (1–50), optional `projectId` | Monotonic cursor page of the redacted journal (`entries`, `nextCursor`). Observer reads and supervisor messages are excluded from **progress** evidence. |
| `activity.note` | `tag` (`^[a-z][a-z0-9_.-]{0,50}$`, default `manager.note`), `message` (≤ 12000), `requestId` | Idempotent manager/guard note with an idempotent receipt. |

`supervision.status` / `supervision.configure` are the **adaptive, code-only** checks — the daemon
never invokes a model, kills a command, or submits a worker for them:

| Method (`call`) | Params | Notes |
| --- | --- | --- |
| `supervision.status` | optional `projectId` | `snapshots`: last/next check, observed phase, and settled snapshots. |
| `supervision.configure` | `assignmentId`, `policy` (object), `requestId` | Persist the check/review policy. Unknown policy fields are rejected; there is **no execution deadline**. |

Policy fields and defaults: `enabled` (`true`), `startIntervalMs` (`10000`), `activeIntervalMs`
(`60000`), `commandIntervalMs` (`120000`), `idleWarningMs` (`900000`), `ackReminderMs` (`300000`),
`maxAckReminders` (`3`, 0–8), `expectedQuietUntil` (`null`), `nextReviewAt` (`null`), `reason`
(string ≤ 2000). Intervals are accepted in the range 1000–86400000 ms. These are **observation/review
timings, never worker execution deadlines**; `contextWindow`/`maxTokens` and the assignment budget
are separate. Expected quiet periods suppress inactivity alerts; a separately requested
`nextReviewAt` still wakes the manager. Unacknowledged **delivered** events are re-sent with the
**same event ID** under bounded, backoff-counted reminders — reminders never create another worker.

**Independent daemon guard** (`pi-durable guard --config <path> --thread-id <EXISTING_UUID>`) is a
**separate code-only process**, not the daemon's own timer. It:

- **Owns its own guard lock** — an exclusive `runtime-guard.lock` — which tracks the **GUARD
  process only**; it is **separate from the daemon state lock** (`service.lock`, which the running
  service owns). Holding `runtime-guard.lock` never makes the guard the daemon owner, and a live/
  unknown guard owner is refused — review before starting another guard; only a **verified-dead**
  owner's stale lock is reclaimed (never signalled or reused by PID).
- Checks daemon health on its interval (default 10 s), persisting `runtime-guard-status.json` and a
  `runtime-guard-journal.jsonl`. A **live/unknown owner with an unavailable socket is held for
  review, never killed**; a **verified-dead** owner may be restarted through the normal service CLI.
- **Pauses** automatic restart on an explicit `service stop`/`service.shutdown` (`guard-pause.json`);
  `service start` clears that intent. Stopping the guard itself leaves the daemon and workers running.
- Reports prolonged failures to the explicit manager thread via the documented `codex queue` command
  (bounded backoff, redacted, code-only — no model call). It **never reads a credential**.
- Existing **quarantine/checkpoint** rules still hold in-doubt commands for operator review; there is
  **no exactly-once external-execution claim**.

**Capability-gate the new surface.** `manager.decision`, `activity.list`, `activity.note`,
`supervision.status`, and `supervision.configure` exist only in the local-reliability build. Confirm
them via `service.capabilities` before use; against an older service, fall back to the existing
review/ack workflow and do not invent replacement methods. The live console refuses to attach
(exit/error) unless the service advertises `activity.list`.

- Binding is **explicit** (`projectId` + `threadId`) and effective **from now** — no historical
  replay — though an already-running assignment whose future terminal is a wake **will** notify. A
  Pi worker can **never** choose/change the target thread or run Codex.
- The dispatcher spawns the documented `codex queue --thread <UUID> --message <TEXT>` with an ARGV
  ARRAY (no shell) under a minimal trusted-host env allowlist (`PATH`/`HOME`/locale/platform paths).
  No model API key or provider secret is passed to the child, and no Codex daemon is bootstrapped or
  restarted.
- `manager.status` surfaces delivery health/outbox state; `enabled` is **truthful** — it is
  `false` whenever `config.manager.enabled` is `false` (the coordinator still records durable
  events, but **nothing dispatches**). A missing/offline/non-zero `codex` CLI is reported honestly
  (never a fake success) and retried with bounded backoff. There is no idle LLM heartbeat.
- `manager bind` is the **default** for a new/imported project managed from the Codex GUI with a
  known existing thread: bind the explicit project/thread **before** the first assignment, then
  **yield to events**. A bounded manual `assignments wait` is a **fallback only** (unbound or
  unhealthy). A standalone CLI human may stay unbound and poll explicitly.
- **Optional ongoing monitoring** (only when the user authorizes it this session): use the
  **native automation tool** — do not invent cron or a manual automation file. Launch the
  **read-only** monitor (`tools/monitor.mjs`, read-only RPC calls only). With `--thread`,
  `--idle-warning-ms` (`15 min` default), and `--receipts-file` set, it may send **one** code-only
  warning per stale-activity burst; the warning is a **no-progress alert, never a deadline**, and
  never time-limits/kills/aborts work. The independent `pi-durable guard` process and the daemon's
  adaptive supervisor are the monitoring backbone; a fixed native GUI heartbeat is **not required**.
  Global budget stays uncapped unless the user sets a finite limit.

### Worker `request_manager` (needs-intervention)

A worker that is blocked calls the `request_manager` tool (`question`, optional `context`). The
tool's trusted callback binds only the **current** assignment/project/conversation, persists the
question as a `manager_request` event, and **safely pauses** the run — no further code/tool side
effects, no provider loop — while **retaining the lease** until you review/cancel/answer. The pause
is truthful and deterministic (code, not an LLM judge). Inspect the question in the event/evidence
(redacted/bounded), then cancel/abort once the old group is gone and submit a **new** assignment
(optionally `parentId`) with your answer.


## Human CTO / generic RPC

A human CTO can read the full transcript (`sessions.transcript`) and drive any method above
through the generic `call` form as a raw RPC tool. There is no separate privileged path; the
`call` entry point exposes exactly the implemented methods.

## Task workflow (0.6 local)

`connect --workflow-id ID` resumes the same task. New task: `connect --path PATH
--objective-file FILE --roadmap-file FILE --request-id ID --thread-id UUID`. Connect returns the
terminal URL for the Codex panel and creates no worker. `workflow.list/status/event` are reads.
`workflow.open/update/submit/answer/review/pause/resume/handoff/finish/stop` are durable mutations; pass a stable requestId.
Use `service.capabilities.operations` for exact parameters. Stop/finish retire the generation.
Questions use `workflow.answer`; acceptance uses `workflow.review` after independent inspection. Reconnect never transfers ownership to a new chat.


### Operator controls

| Method | Required parameters | Behavior |
| --- | --- | --- |
| `workflow.review` | `id,eventId,decision,note,evidenceHash,requestId` | `accept` or `revise`; evidenceHash is the SHA-256 returned by assignments.evidence summary. Records decision → verifies/reviews → acknowledges. Lost replies reconcile without another verdict. |
| `workflow.pause` | `id,note,requestId` | Closes tool/provider admission; drains the current tool without a deadline, retains lease, then emits a blocked event with operatorPause=true. |
| `workflow.resume` | `id,summary,requestId` | Only confirmed operator pauses; verifies checkpoint, persists continuation packet, cancels/joins prior session, submits one child and acknowledges old events. |
| `workflow.handoff` | `id,expectedThreadId,threadId,note,requestId` | Explicit owner transfer for settled or safely paused work. Retracts old wakes and reissues unresolved events to the destination. |
| `assignments.pause` | `id,note,requestId` | Low-level pause; prefer workflow.pause so the roadmap and resume state remain connected. |

Read `workflow.status.operatorPause.status`: `pausing` is a pending request, `paused` confirms
that tools drained, and `error` requires inspection. No frozen process is resumed; a new session
receives bounded command/change history, evidence hashes, original task and manager summary.
The immutable evidence remains available for deeper recovery. The summary records truncation.

Multi-step handoff/resume intent survives restarts. If an operation is in progress, retry the
reported method with its original request ID and unchanged payload before another mutation.
An old connect request cannot reclaim a transferred task. These controls do not override crash
quarantine and do not promise exactly-once external command execution.
