# Host browser validation and durable working briefs

Codex configures checks; Pi implements and repairs; Codex independently accepts.
These features use the existing local service and model endpoint. No separate
model, Decisions service, or host-shell access is introduced.

## Configure before submitting

Use `service.capabilities` first. With no writer holding the project checkout,
call `validation.configure` with a stable request ID:

```json
{
  "projectId": "<existing-project-id>",
  "profile": {
    "name": "counter",
    "serveDirectory": "dist",
    "steps": [
      {"action": "click", "selector": "#add"},
      {"action": "text", "selector": "#count", "value": "1"},
      {"action": "reload"},
      {"action": "text", "selector": "#count", "value": "1"}
    ]
  },
  "requestId": "<stable-manager-request-id>"
}
```

`validation.profiles {projectId}` lists these manager-defined checks. Workers
cannot configure or weaken them. A profile has at most 24 steps; a project has
at most eight profiles. Supported actions: local-path `goto`, `click`, `fill`,
`press`, exact `text`, exact element `count`, and `reload`. Selectors are
Playwright locators. No evaluate/script/shell action is accepted.

Pi builds the site with its ordinary sandboxed tools, then calls
`host_validate {profile: "counter"}`. The runner snapshots public static assets,
serves that immutable snapshot on an ephemeral loopback port, and runs isolated
headless Chrome. It records the profile and snapshot hashes, completed steps,
failure text, console errors, and a screenshot with SHA-256. Pi receives the
result in the same assignment and can fix and retest without a manager wake.
Read results with `validation.results {assignmentId}`. Full reports, manifests,
and screenshots live under the service state directory's `validation-artifacts/`.

A failed check is evidence, not an assignment failure. A passed check proves only
that profile against that snapshot, not acceptance or correctness of later edits.
Replayed tool calls return the original result. An interrupted validation that
never recorded completion is `in_doubt`; it is not silently rerun. The manager
inspects it and deliberately authorizes continuation as with other uncertain work.

## Durable working brief

Pi calls `working_brief` with `objective`, `decisions`, `completed`, `issues`,
`nextStep`, and up to eight relevant project-relative `paths`. Notes are bounded
(6000 characters total); file hashes are computed by trusted code. The latest
brief is supplied before model requests, independently of transcript compaction.
An explicit child assignment inherits its nearest parent's brief within the
same project. Unrelated assignments/projects do not inherit notes.

`brief.inspect {assignmentId}` returns the brief with `unchanged`, `changed`, or
`unavailable` file freshness. Worker notes are always labelled as untrusted
history; the current task and manager decisions take precedence. They are not
proof that tests ran. Host results are separate observed records. Update the
brief after meaningful changes or failed tests and before asking a question.

## Boundaries and current limitations

- macOS and the installed Google Chrome application are required for host runs.
- This runner tests static builds, not arbitrary Playwright/Node scripts or
  backend services. Existing shell/unit/build tests stay sandboxed.
- The isolated browser has no user profile, credentials, downloads or granted
  permissions. External requests, WebSockets and service workers are blocked.
  Project JavaScript runs only as ordinary browser content, never as host Node.
- Snapshot serving rejects symlinks and excludes hidden files and node_modules;
  limits are 512 files, 8 MiB per file, and 32 MiB total. Profile directories must
  contain index.html. No directory traversal or live filesystem proxy is offered.
- Ten-second action and fifteen-second navigation limits bound test failures;
  these are not worker execution deadlines.
- Briefs improve continuity but do not guarantee model productivity. Repeated
  failures still need manager diagnosis. No automatic acceptance or hidden retry
  worker is created. There is still one writer per checkout.
