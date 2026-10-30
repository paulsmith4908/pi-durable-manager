# Local Pi reliability

This local build prioritizes reliable operation on the current Mac. Distribution work is deferred.

## Visible activity

`pi-durable console --config /absolute/path/config.json --port 5182` opens a read-only loopback
activity viewer for Codex's right-hand browser panel. It shows the actual durable journal, not a
second worker or a fabricated shell. `pi-durable watch --config /absolute/path/config.json` reads
the same records in an ordinary terminal. Use `--after SEQUENCE`, `--project-id ID`, or `--once`.
A viewer disconnect does not stop the service. Both viewers reconnect from sequence cursors.
The journal begins with this build's installation; historical pre-journal work is not invented.

Records include manager requests/results, emitted worker text (not hidden reasoning), tool calls,
process starts, command results/output tails, state changes, check policies, wake delivery receipts,
decisions, and acknowledgments. Large values are explicitly bounded; full assignment evidence and
content-addressed artifacts remain separate. Known credentials and sensitive fields are redacted.
The browser is read-only; it refuses writes, cross-origin requests, and invalid Host headers.

## Adaptive supervision

The daemon runs code-only checks. `service.capabilities` describes the exact new methods:

- `activity.list {after, limit, projectId}` — cursor-paged, byte-bounded journal.
- `activity.note {tag, message, requestId}` — idempotent manager/guard note.
- `supervision.status {projectId}` — observed activity and last/next checks.
- `supervision.configure {assignmentId, policy, requestId}` — persistent policy.
- `manager.decision {eventId, action, note, requestId}` — decision before action/ack.

Policy fields: `enabled`, `startIntervalMs`, `activeIntervalMs`, `commandIntervalMs`,
`idleWarningMs`, `ackReminderMs`, `maxAckReminders`, `expectedQuietUntil`, `nextReviewAt`, `reason`.
Defaults are 10-second startup checks, 60-second ordinary checks, 120-second command checks,
15-minute inactivity alerts, and at most three unacknowledged-delivery reminders with backoff.
These are observation/review timings, never worker execution deadlines. Expected quiet periods
suppress inactivity alerts, while a separately requested review time can still wake the manager.
Actual worker activity excludes observer reads and supervisor messages. Running alone is not
progress evidence. No supervisor check invokes a model, kills a command, or submits a worker.

When a wake arrives, inspect its real evidence and existing decision. Persist the decision before
acting, carry out/reconcile the action idempotently, then `manager.ack`. A completed review/cancel
is also durable action evidence for older clients. Other unhandled events cannot be silently acked.
Delivered-but-unhandled events reuse the same event ID; reminders never create another assignment.

## Independent daemon guard

`pi-durable guard --config /absolute/path/config.json --thread-id EXISTING-UUID` is a separate
code-only process. The installed local instance runs it detached, independently of the viewer.
It checks service health every ten seconds, records last/next checks, and reports prolonged
failures to that explicit Codex chat through the documented queue command. It never reads a key.
A live/unknown owner with an unavailable socket is held for review, never killed. A verified-dead
owner may be restarted through the normal service CLI; existing quarantine/checkpoint rules still
hold in-doubt commands for operator review. There is no exactly-once external-execution claim.
An explicit `service stop`/`service.shutdown` pauses automatic restart. `service start` clears
that stop intent. Stopping the guard itself leaves the daemon/workers running.

The private state directory retains `runtime-guard-status.json`, `runtime-guard-journal.jsonl`,
and its ownership lock. The viewer labels stale guard receipts rather than treating an old
healthy label as live evidence. A duplicate live/uncertain guard owner is refused.

## Recovery boundaries

Schema 8 adds activity/control tables without rewriting existing assignments or Pi conversations.
Back up quiescent state before upgrading. A pre-schema-8 binary must not be pointed at migrated
state; use the matching binary and review a state backup explicitly if recovery is necessary.
No automatic rollback, commit, push, deploy, endpoint replacement, or secret read is introduced.
The independent guard and daemon are local processes; automatic login/reboot installation is not
part of this change. Native queue transport and a reachable existing Codex chat are still needed
for GUI wake delivery. A delivery receipt and actual manager handling are tracked separately.
Pi remains opt-in; ordinary tasks stay with Codex unless the user selects or requests Pi.
