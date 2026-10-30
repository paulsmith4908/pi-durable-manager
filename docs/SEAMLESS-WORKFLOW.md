# Selecting Pi in Codex

Select Pi Durable for your message and describe the work. Codex uses the plugin instructions to
connect the local runtime, create/import your repo, save a roadmap, attach the current chat and
open the actual Pi terminal beside it. Selecting the plugin is instruction routing; the plugin
has no hidden executable selection hook. Nothing runs merely because it is installed.

Codex owns the plan and review. Pi owns the delegated implementation. The terminal observes the
same existing worker; it never starts another agent. You can ask Codex to steer, answer a question,
stop Pi, or take over. Unrelated tasks remain direct Codex work.

## What persists

The service's workflow record stores the objective, roadmap, owner chat, generation and assignment
lineage. Every multi-step mutation records its intent first. Repeating the same request resumes
or returns its receipt; changing its payload is a conflict. A worker question is keyed by its event
ID even if a caller retries with a different request ID. Answers pause safely, verify the checkpoint,
join the old worker and start a fresh continuation. Old tasks cannot be resurrected by late wakes.

Commands: `pi-durable connect`, `workflow list/status/update/submit/answer/review/pause/resume/handoff/event/finish/stop`.
Use `pi-durable call service.capabilities --json` for the exact parameter descriptors. Commands
accept JSON files and stable request IDs; no shell quoting of model text is needed. The normal
project/session/assignment APIs remain available for detailed operator work.

## Supervision and evidence

The code supervisor uses actual worker/tool activity, not a running label. The separate guard
checks daemon health. Neither invokes a model. Task owners receive questions, completion, failures
and selected review alerts. Stop/finish retires that task's binding and events. Acknowledgment and retirement remove
still-queued Pi messages using their saved Codex receipts; restart recovery repeats cleanup
idempotently. This uses the installed Codex app-server `thread/queue/delete` API via a temporary
stdio control process, which starts no agent or turn. It never deletes an unrelated queued message.
`manager.status.queueCleanup` reports bounded retry failures, and the activity journal records
each removal. Messages whose turn already started cannot be recalled; the skill checks eligibility
before acting on those. During normal work
Codex yields instead of repeatedly polling. The terminal's display refreshes consume no LLM tokens.

Each acceptance still requires Codex to review files, tests and evidence. A worker summary is not
proof. Crash recovery never promises exactly-once shell execution; uncertain commands stay held
for review. No hidden time limit, automatic commit, publish, endpoint change or Decisions API.

## Current limits

- macOS local beta; compatible Node, Git and Codex queue support are required.
- The installed plugin and service must match. Connect refuses a live incompatible runtime rather
  than replacing it while work might be running.
- One task owner/writer per checkout. Switching owner chats requires an explicit operator handoff;
  reconnect refuses to silently take over another chat.
- The pane shows emitted text and durable tool/output records, not hidden reasoning or unrestricted
  upstream slash commands. Command output is currently displayed as recorded completion tails.
- A question resumes in a fresh session with the original task, explicit answer and existing files;
  it does not restore every token of a prior context.
- Mac sleep can postpone execution/network work; GUI wakes require the app to be available. No
  login/reboot launch agent is installed. Connect starts a cleanly stopped service on next use.
- The read-only terminal follows the active task. Selecting a historical assignment manually stops
  automatic following until the pane is reloaded.
- No classifier filters explicit questions. Decisions remains deferred.


## Pausing and recovery

Ask Codex to pause Pi when you want a stable review point. The service immediately stops admitting
new tools and lets the current tool finish normally. A long command remains running; pause is not
a hidden timeout or force kill. The terminal and workflow status distinguish pausing from paused.

Resume creates a fresh continuation only after verifying the checkpoint and joining the previous
worker. Its durable packet includes the objective, roadmap, your manager's remaining-work summary,
recent completed commands and exit codes, changed paths and evidence hashes. The history is bounded
and reports truncation; it is not a full restoration of the prior model context.

Explicit handoff moves a settled or safely paused task to another existing Codex chat. It removes
old queued wakes and reissues unresolved questions/reviews to the new owner. The old chat cannot
reclaim ownership by replaying an earlier connect call. Review is a durable operation tied to the
inspected evidence hash; a changed checkout fails acceptance instead of silently passing.

Recovery tests include real daemon SIGKILL during a command, confirmed-pause restart, lost replies
after cancel/submit/decision/review/ack/handoff, duplicate continuation requests, and stale evidence.
A command with an uncertain outcome remains quarantined for operator review; restart never blindly
repeats it. Sleep, full Mac reboot and GUI availability remain separate operating-system limits.
