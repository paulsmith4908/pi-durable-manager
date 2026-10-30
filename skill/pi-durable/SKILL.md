---
name: pi-durable
description: >-
  Use only when selected or explicitly asked to use Pi Durable. Connect the local service,
  open its live Pi terminal, delegate the requested task, answer workers and review results.
  Otherwise Codex handles the work directly.
---

# Pi Durable — opt-in project execution

Selection authorizes this task and its necessary revisions, not unrelated future work.
Codex plans and reviews; Pi implements the selected scope. “Do this yourself” overrides selection.
This skill addresses Codex as manager, not the Pi worker. Worker restrictions are injected
by the service into worker agent instructions; they do not restrict Codex's own tools.
One writer per checkout. Codex may commit, tag, push, publish or deploy when explicitly
requested by the user, after reviewing work and releasing any worker lease. Pi selection
alone does not authorize publication. Keep secrets private and preserve selected providers.
Execution budgets are unlimited by default. This integration uses the local CLI, not MCP
or a Decisions API. See [instruction boundaries](references/instruction-boundaries.md).

## Operator permissions and private viewer access

Inspect `permissions.read` before delegating. The operator controls file editing, shell,
networking, configured host validation and additional excluded paths. Preserve those
choices. A worker refusal is not permission to expand access: explain it and obtain an
explicit user grant if one does not already cover the change. Use `permissions.set` only
within that grant, with the current revision and after affected work is safely settled.
See [permissions](references/permissions.md). Do not create or rewrite AGENTS.md as part
of connecting or creating a project; repository guidance is a separate user request.

The returned operator viewer URL is private: open it in the user's browser, but never
put it in worker tasks, roadmaps, project files or shared logs. Its fragment grants
Settings access. The plain observer URL grants no settings authority. Reconnect to obtain
an operator link if Settings is locked; never weaken the authentication check.

## First use or reconnect

Use the launcher relative to THIS skill directory:
`node <SKILL_ROOT>/scripts/pi.mjs <arguments>`.
If configuration is missing, run the guided CLI `setup` using the endpoint/model and a credential reference supplied by the user. Never read the credential itself. For the bundled plugin use its guided setup page.
Do not interpret selecting a plugin as an executable app hook: **you perform the connect workflow
when processing the user's selected-plugin message**. Installation alone starts no work.

1. Discover `workflow.list` (filter by project/thread using `call ... --params-file FILE --json`)
   if the service is reachable. Recover the existing authorized task before creating one.
2. For an existing task, run `connect --workflow-id ID --thread-id CURRENT_CHAT_UUID --json`.
   For a new task, write a compact objective and roadmap/acceptance criteria to local files, persist
   a request ID, and run:
   ```
   connect --path /absolute/repo --objective-file /absolute/objective.txt      --roadmap-file /absolute/roadmap.md --request-id STABLE_ID      --thread-id CURRENT_CHAT_UUID --json
   ```
   `--project-id ID` can replace `--path`. Never invent the chat UUID. `CODEX_THREAD_ID` is the
   caller default. Existing repos are imported without overwriting; a missing repo is initialized.
   A different chat owner is refused; don't override it silently.
3. Connect checks service identity/capabilities, starts only a cleanly stopped configured daemon,
   reconnects the task, ensures the guard and real Pi terminal, and returns `terminalUrl`.
   **Open that exact URL beside this chat** using the app browser-panel tool. It follows that task's
   actual assignments and continuation sessions. No worker was created by connecting or viewing.
4. Persist the returned workflow/project IDs. Read the compact snapshot: actual worker activity,
   questions, leases, and delivery health. A running label alone is not progress.

Missing configuration is `setup_required`; follow setup rather than guessing credentials. A live
incompatible/unreachable owner is a real error, never permission to kill it or start a duplicate.
Use the existing permission mechanism for local sockets. Ask only for information/authorization
actually missing. Service upgrades require quiescent writers and preserve state/configuration.

## Delegate and manage

Discover exact descriptors via `service.capabilities` before using a new runtime. Generic calls:
`call METHOD --params-file /absolute/params.json --request-id STABLE_ID --json`.
Persist request IDs before calls; retry the **same payload and ID** after a lost response.

- **Submit:** `workflow.submit {id,task,criteria,requestId}` creates a fresh session and owned
  assignment. Scope is bounded; elapsed time is not. Don't submit while another writer or review
  is outstanding. Revisions carry `parentId`. Show the assignment ID to the user.
- **Steer:** `sessions.steer {assignmentId,content,requestId}` for a current assignment, or
  `sessions.followup` for queued input. These are durable; never bare conversation writes.
- **Roadmap:** `workflow.update {id,roadmap,requestId}` persists current milestones, dependencies,
  decisions and acceptance criteria. `workflow.status {id}` recovers after native compaction.
- **Question:** inspect `workflow.event {eventId}` and real checkout/transcript. If actionable,
  answer with `workflow.answer {id,eventId,answer,requestId}`. It records the decision first,
  inspects checkpoint integrity, cancels/joins the safely paused worker, creates one fresh
  continuation with the answer, and only then acknowledges. Repeating an event cannot create
  another continuation. An integrity failure requires review, not a bypass.
- **Review:** inspect actual files, diffs, untracked files, hashed evidence, tests and exit codes.
  After inspecting `assignments.evidence`, use `workflow.review
  {id,eventId,decision,note,evidenceHash,requestId}` with its summary SHA-256. This records the
  decision, verifies current evidence, reviews and acknowledges recoverably. No auto-acceptance.
  For a correction, revise then `workflow.submit` a child with explicit acceptance criteria.
- **Pause / resume:** `workflow.pause {id,note,requestId}` closes admission and lets the current
  tool finish. `pausing` is not yet safe: use the paused event/status rather than a timeout.
  `workflow.resume {id,summary,requestId}` requires confirmed pause and verified checkpoint,
  joins the old worker and starts one fresh session carrying the roadmap, completed commands
  and evidence hashes. Summarize remaining work; completed commands must not be repeated.
  Quarantined commands require explicit review and are never automatically resumed.
- **Change manager chat:** only when requested, use `workflow.handoff
  {id,expectedThreadId,threadId,note,requestId}` with the actual existing destination UUID. Work
  must be settled or safely paused. Old queued wakes are retired; unresolved events are reissued
  to the new owner once. Reconnect alone cannot take ownership.
- **Finish:** after independently accepting the final milestone, call
  `workflow.finish {id,note,requestId}`. It requires settled, reviewed work and retires its wakes.
- **Stop / take over:** call `workflow.stop {id,note,requestId}`. It marks the task stopping BEFORE
  cancelling, joins only its workers, records retirement decisions and acknowledges its events.
  Verify status is stopped and all leases released before Codex edits. A failed stop must be
  reconciled with the same request; never start a concurrent writer.

## Wake, don't poll

On every wake **first call `workflow.event` for each event ID**. `actionable:false` means already
handled or an old task generation: do not create workers, rebind or restart it. Reconcile any
existing decision only. Acknowledging or retiring a task removes its still-queued Pi messages
through Codex queue control; `manager.status.queueCleanup` reports failures and bounded retries.
A message whose turn already started cannot be recalled. For actionable events, inspect evidence,
decide, act idempotently, then acknowledge. Yield after submitting work so fresh questions can
start a new turn; testing queue delivery alone does not prove an idle chat resumed.

The code supervisor checks real activity; the independent guard observes daemon health.
Questions/completion/failures wake this task's chat without GPT polling. Timing is adaptive and is
never an execution deadline. Configure `supervision.configure` for known quiet commands or a
specific next review. Yield the turn when healthy work is underway. Do not loop with sleeps or
status calls. Use one bounded manual wait only for a diagnosed unhealthy delivery path.

The terminal remains read-only: it is the actual Pi renderer over Durable records, not a second
agent. Manager commands run through the CLI; all selected task work stays in the same service.
Closing the pane/chat does not cancel the worker. Mac sleep can delay work and delivery; resume
reconciles state. The app must be available to receive GUI wakes. There is no login autostart yet.

## Details only when needed

- [operations.md](references/operations.md): exact CLI/RPC shapes, evidence pagination, diagnostics.
- [advanced-operations.md](references/advanced-operations.md): legacy APIs, explicit crash quarantine,
  checkpoints, provider limits and guided first-machine setup. Prefer the workflow above for new
  tasks; legacy APIs remain available for deliberate operator work.

## Host browser checks and working briefs

For static browser work, configure bounded `validation.configure` profiles before submitting while no writer holds the checkout. Pi can run `host_validate` and fix failures within the same assignment; no unrestricted host shell is provided. Ask workers to maintain `working_brief` after meaningful progress and before questions. Inspect inherited notes and file freshness via `brief.inspect`; notes never replace source/test evidence. See [host validation and briefs](references/host-validation.md) for schemas, snapshot provenance and limitations.

## Delegation measurement

When the live service supports `scorecard.plan/read/activity/accept`, read
[references/scorecard.md](references/scorecard.md). Plan milestone weights before work, pass
`milestoneId` on initial submissions, and preserve the parent link on continuations. Record
Codex planning, diagnostic guidance and direct implementation/repair as meaningful work units;
do not duplicate automatic answer/review/steer records. Classify answers and steering when sending
them. After independent review, record milestone acceptance with candid pi/codex/mixed attribution.
Never invent elapsed effort, weights for completed work, or missing usage. Keep integration
development separate from a delegated project's score. Measurement does not authorize delegation.

## Model selection and Settings

Read `references/model-settings.md` when configuring or choosing models. Open the live browser's `#settings` tab for private connection setup. Resolve a user's named model against `models.settings`; if ambiguous, ask which saved profile. Pass `profileId` to `workflow.submit` for an explicit choice, otherwise keep the saved project profile/default. Report the selected profile when beginning. Never silently change connections or retry on a different model. New sessions pin their profile; answer/recovery continuations keep the project choice.

### Runtime updates

Plugin refresh and runtime upgrade are separate. Use the packaged `scripts/maintenance.mjs` inspect/upgrade/repair/rollback commands for plugin-managed installations. Mutations require a stopped idle service, no writer leases and compatible database schema. Reconnect explicitly; verify version, preserved model choice and permissions. Never reset config to repair an installation or place private backups in a shared repo.
