# Actual Pi terminal, attached to Durable workers

The observer uses Pi Coding Agent 1.4.0's **actual** `UserMessageComponent`,
`AssistantMessageComponent`, `ToolExecutionComponent`, built-in bash/read/write renderers, and theme code, rendered by
`@earendil-works/pi-tui` 1.4.0. The browser pane is xterm.js receiving that renderer's VT
output. It is not an HTML recreation of Pi's appearance.

The full Pi `InteractiveMode` owns an `AgentSession` and coding-agent session storage.
It cannot simply be pointed at this service's Durable assignment. Instead, the small adapter
feeds existing, redacted Durable journal records into the upstream display components.
It never constructs an agent, starts inference, creates a conversation, or submits work.

## Run

From an installed package, in a real terminal:

```sh
pi-durable-terminal --config /absolute/path/config.json --assignment-id EXISTING_ASSIGNMENT_ID
```

For a Codex browser pane:

```sh
pi-durable-terminal --config /absolute/path/config.json --browser --port 5183
```

During source development use `node bin/pi-durable-terminal.js` after `npm run build`.
Open the printed loopback URL beside the chat. The selector switches among existing
assignments only. An explicit `--assignment-id` chooses the initial one. `--socket PATH`
supports services using an explicit socket path.

## Overview and Terminal

The browser opens on **Overview**. **Terminal** attaches the actual Pi renderer when
selected; switching back releases that display connection. A `#terminal` URL opens
directly on Terminal. Both tabs observe the same existing workers.

Overview shows the task, runtime status, latest recorded activity and its timestamp,
milestones, outstanding Codex questions/reviews, next step, and recent task activity.
Use the `?workflowId=EXISTING_ID` URL returned by connect for the complete task view.
Legacy assignment-only views show the assignment state without inventing a roadmap
or claiming that the beginning of a long journal is recent activity.

**Pi Durable owns automatic runtime updates:** assignment transitions, tool/command
events, worker questions and requests for review. **Codex owns the roadmap and its
milestone states**, answers and acceptance decisions. Codex persists milestone changes
using the existing `workflow.update {id,roadmap,requestId}` call. Use checklist lines:

```markdown
- [x] Ordering decision answered
- [~] Implement the function and tests
- [ ] Independently review and accept
```

`[x]` means complete, `[~]` in progress, and `[ ]` planned. Update this checklist when
scoping work, answering a milestone decision, and reviewing results. Prose-only
roadmaps remain visible in full. Legacy `Milestone 1: ...` lines show **Status not
recorded** until Codex explicitly records their individual states. Runtime completion
never guesses checklist states. **Assignment accepted** and workflow **Complete**
are distinct; only a recorded workflow finish marks the whole task complete.

The read-only `/overview` route combines existing service records; it writes no state
and never starts inference. Visible pages refresh every 2.5 seconds with one refresh
at a time. Hidden pages stop refreshing. A failed read preserves the previous view
with a visible stale-snapshot notice; the displayed activity timestamp always comes
from a recorded event, independently of the page refresh timestamp. Recent history
is bounded and scoped to the workflow's assignments. Recent work shows the newest
entry first, with labeled color markers: blue Work, violet Check, green Passed,
amber Review, red Error, and muted Note. Green reflects recorded browser passes or
Codex acceptance; worker prose alone never establishes a successful outcome.
Worker text is displayed as text,
never interpreted as HTML.

Page Up/Down and Home/End scroll the actual Pi viewport; Ctrl+O or **Tool output** expands
tool results. The browser follows the current worker automatically, including fresh continuation
assignments. Choosing an older assignment shows **Viewing history** and temporarily pins that
history. **Latest** restores **Following current worker**, switches to the current assignment,
and scrolls to its latest output. Reviewing an old assignment cannot steal live selection.
In a native terminal, Ctrl+C or `q` detaches the
observer. Closing either display leaves the daemon and workers alone.

## Boundaries

- Viewers use compact assignment listings, never `assignments.show` (which embeds growing
  evidence). The 1 MiB transport guard stays enabled. Journal pages that exceed it retry at
  the same cursor with fewer entries, down to one; an oversized single entry is an explicit
  display error, not silently skipped. Attachment starts within 400 journal records of the
  selected assignment's last observed activity, so long projects display promptly. Older
  history remains accessible through the paginated journal APIs.
- Overview read errors and terminal stream errors are reported as display failures. They do
  not prove the daemon or worker stopped. Retried reads preserve the last overview/output;
  a fresh attachment replays the recent recorded window. Worker liveness must be checked
  against actual activity timestamps, independently of the browser's connection label.

- Only a fixed allowlist of read RPCs is available to the observer. No prompt input,
  slash commands, steering, cancellation, acceptance, or wake acknowledgments are forwarded.
  Those operations remain with Codex and the service's normal manager interface.
- The pane shows the existing assignment/session IDs and actual current state. No worker is
  started automatically. If no assignments exist, it says so.
- Journal records are durable; the viewport retains a bounded recent window. The service's
  normal journal/evidence APIs retain full audit history. Command starts and completed output
  are shown; per-byte stdout and hidden model reasoning are not supplied by this journal.
- Repeated journal records do not duplicate tool cards. Unfinished tools remain pending.
  Actual nonzero command exits remain failures when the matching tool-result record arrives.
  Replay does not start upstream's live elapsed-time clocks; durations come from recorded results.
  Other tools use Pi's generic tool component. The edit preview renderer is intentionally omitted
  because it reads the current file rather than the recorded operation.
- Worker-supplied terminal control sequences, clipboard OSCs, C1 controls, and bidi overrides
  are stripped before rendering. Local browser assets need no CDN. The HTTP server binds
  loopback, checks Host/Origin, limits clients and slow-reader buffers, and refuses writes.
- The upstream UI dependency is pinned. Custom theme discovery, process execution helpers,
  extensions, and image decoding are disabled at extraction boundaries. No credential loader,
  agent loop, model provider, or MCP module is bundled. The configuration is read as references;
  the observer never resolves a credential.

The existing manager wake bindings can be disabled while Codex works directly. Viewing an
assignment never re-enables them. Still-queued Pi messages are removed on acknowledgment/retirement; an already-started GUI turn must be
deduplicated without restarting declined work.

## Upstream provenance and rebuilding

`vendor/pi-ui/provenance.json` records the pinned source archive hash, UI bundle hash, theme hash,
and build inputs. MIT and bundled dependency license notices are preserved alongside it.
The selected upstream display component implementations are unmodified; only their host
boundaries above are replaced. No fork of the Pi runtime is required.

To rebuild, obtain the official `@earendil-works/pi-coding-agent@1.4.0` npm tarball, extract it,
and provide its upstream MIT `LICENSE` in the extracted package directory (the npm archive
does not include it). In an isolated build-tools directory install with lifecycle scripts disabled:

```sh
npm install --prefix /absolute/build-tools --ignore-scripts esbuild@0.25.12 chalk@6.0.0 highlight.js@10.7.3
node tools/build-pi-ui-vendor.mjs /absolute/extracted/package /absolute/build-tools /absolute/pi-coding-agent-1.4.0.tgz
```

The upstream package must be able to resolve those build dependencies (for example, extract
it under that same build-tools directory). The extraction rejects agent/auth/provider/MCP
inputs. Re-run the native-terminal tests, type checks, and packaged-runtime verification after
rebuilding or changing the pinned version.


### Multiple panes and reconnecting

Hidden panes release their live display connection; returning to them replays the durable history.
The viewer supports up to eight simultaneous visible displays, with capacity enforced even during
concurrent connections. A full viewer reports an explicit capacity message and retries with bounded
backoff. Closing unused panes frees capacity. Connection loss preserves the last rendered output;
Reconnect retries explicitly. These operations never stop, restart or create workers.

### Readable assignment names

The picker shows manager-owned titles from the workflow roadmap, followed by a
plain-language state. Record a line when submitting or continuing an assignment:

```text
- [assignment:RETURNED_ASSIGNMENT_ID] M2 · Playable interface — revision 1
```

Use the returned ID, and save the roadmap with `workflow.update`. These labels
are display metadata, not instructions to a worker. Unlabelled assignments use
stable submission numbers; the viewer never guesses milestones from task prose.
Hover over the picker for the exact ID and raw state. Selection, history and
Latest still use the original IDs. Labels are rendered as text, not HTML.
