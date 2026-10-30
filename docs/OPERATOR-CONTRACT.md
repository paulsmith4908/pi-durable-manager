# OPERATOR-CONTRACT.md — operator-facing command and protocol contract

Status: **PROPOSED, PARTIALLY VERIFIED, NOT IMPLEMENTED.** Every command, flag, JSON field,
socket operation, and protocol message below is a **proposal**. None of it is an installed CLI,
a running service, or a verified API. Names may change; treat all runtime behavior as unproven
until milestone evidence exists. Documentation checks only; no product/runtime test has been run.

This document is the operator contract companion to `PLAN.md`. `PLAN.md` holds authoritative scope
and source facts. Where this file names a real upstream capability it says so explicitly and labels
the wrapper semantics as proposed. Unsupported API entries stay **capability-gated pending spike**.

## 1. Model of the system

Codex is the native desktop GUI CTO: it plans and reviews and never implements. Codex stays in the
GUI and executes the local CLI/client with its **existing shell tools**; the **short Codex skill**
is what teaches correct usage of that CLI/client. There is **no replacement Codex manager process**:
the skill documents and orchestrates the local service, it does not re-implement the manager. See
the corrected architecture direction (GUI → skill/client → local service → Pi conversations →
Modal inference + sandboxed workspace tools).

Three process roles, one writer each:

- **Service** — owns the restricted Unix socket and the durable store. It is the sole writer of
  that store. It is supervised with recovery.
- **Client** — CLI and composable script API. Speaks the versioned protocol over the socket. It is
  **never a second writer** of the store.
- **Workers** — Pi conversations running model turns and sandboxed tools inside a project checkout.

`conversation != project`. A project is a registry entry bound to one local Git repo/checkout. A
conversation is a worker thread with its own transcript. A prompt **fork is not a filesystem fork**:
it copies conversation entries up to an entry id and receives a fresh provider session identity; it
does not copy files.

## 2. Service lifecycle (PROPOSED)

```
pi-durable service start        # foreground or supervised
pi-durable service stop
pi-durable service status
pi-durable service doctor       # environment, socket, store, permissions, version report
```

- `start` refuses to run if another live service already owns the socket. Stale-socket detection
  must confirm the owner is dead before unlinking; never unlink a socket a live process owns.
- `stop` requests a graceful drain; it does not silently kill in-flight model turns.
- `status` reports service up/down, socket path, store schema version, and active project counts.
- `doctor` is read-only and never mutates the store or repo.

## 3. Projects (PROPOSED)

```
pi-durable projects create  --root <dir> [--description-file <path>] [--profile <name>]
pi-durable projects import  --root <dir> [--description-file <path>] [--profile <name>]
pi-durable projects list
pi-durable projects show    <project-id>
```

- `create` requires an **allowed root**. It may safely `git init` **with no commit and no remote**,
  and must **fail on existing paths** unless the operator explicitly uses `import`.
- `import` attaches to an existing checkout without overwriting tracked or untracked files.
- `--description-file` is read as data, never executed. `--profile` selects a non-secret credential
  reference and worker configuration.
- Creation is an **idempotent project-creation journal**: a repeated create with the same identity
  returns the original record rather than making a second project. A **crash reconciliation** pass may
  complete an interrupted journal entry, but never overwrites a ready project.

## 4. Assignments (PROPOSED)

```
pi-durable assignments plan    --project <id> --description-file <f>
pi-durable assignments submit  --project <id> --task-file <f> --criteria-file <f> \
                               --profile <name> [--request-id <id>]
pi-durable assignments submit  --project <id> --manifest-file <f> [--request-id <id>]
pi-durable assignments inspect <assignment-id>
pi-durable assignments list    --project <id>
pi-durable assignments wait    <assignment-id> [--timeout <dur>]
pi-durable assignments steer   <assignment-id> --text <t>
pi-durable assignments follow-up <assignment-id> --text <t>
pi-durable assignments revise  <assignment-id> --review <checkpoint-id>
pi-durable assignments review-checkpoint <assignment-id> --decision accept|revise --review-file <path>
```

**`assignments plan`** produces a **persisted Codex-owned task/criteria manifest**: the concrete
task statement plus explicit acceptance criteria owned and versioned by Codex. Optional worker
"detailed planning" is expressed as an **explicit assignment in its own right** (a planning task
with its own criteria and evidence), not as an implicit step. `plan` does **not** invoke any hidden
manager process, hidden inference, or background decision engine — it only writes the manifest.

**`assignments submit`** creates or selects the conversation/profile named by the manifest and
returns **both `assignmentId` and `conversationId`**. `--task-file` and `--criteria-file` are read
as data, never executed. `--request-id` is the caller-supplied idempotency key (see §6).

**Walkthrough (single assignment, no automatic acceptance):**

```
# 1. operator states a project in plain language
pi-durable projects create --root ~/work/todo-app --description-file todo.md --profile dev
# 2. persist a Codex-owned task/criteria manifest
pi-durable assignments plan --project prj-1 --description-file todo.md
# 3. submit; returns { assignmentId, conversationId }
pi-durable assignments submit --project prj-1 --task-file task.md --criteria-file crit.md \
  --profile dev --request-id req-01J...
# 4. wait is a bounded observation only (short, GUI-friendly; user can attach independently)
pi-durable assignments wait asg-1 --timeout 60s
# 5. inspect the actual diff + test evidence
pi-durable assignments inspect asg-1
# 6. Codex records a review checkpoint; returns checkpointId
pi-durable assignments review-checkpoint asg-1 --decision revise --review-file rev.md  # -> ckpt-1
pi-durable assignments revise asg-1 --review ckpt-1  # linked revision request/assignment ids
#    (or: review-checkpoint ... --decision accept  records Codex's acceptance)
```

Nothing above accepts a result automatically. **Acceptance is Codex's recorded review**, not a
worker exit code. A `revise` decision **returns linked revision assignment/request ids** and
**obtains/reconciles the checkout lease before writing**.

A real provider/model is **fixed configuration**: the pinned Modal `deepseek-ai/DeepSeek-V4.1-Flash`
OpenAI-compatible `/v1` endpoint, referenced by a private credential handle, with no fallback.
Provider/model are not chosen per ad-hoc call. **Reconciling this with `sessions configure
--model`:** a conversation's profile is **currently pinned**; `sessions configure --model` may only
select among **approved, pre-configured profiles** (for example a different pinned model in an
explicitly authorized profile). Arbitrary endpoint or model changes are **rejected** unless the
operator performs an **explicitly authorized configuration change** — they are never silent or
per-call. Fixing the provider does **not** narrow operator capability: full control over
instructions, tools, and session state remains available through `configure`, `reset`, `compact`,
`handoff`, and the operations below.

The client is **composable**: a generic script client can call any **schema-advertised, versioned
service operation** by name over the protocol, so new supported operations do not require a new
named CLI wrapper or wrapper release. When upstream exposes genuinely new functions, a **service
upgrade may be needed to expose them** — but the generic client still needs no new named wrapper per
operation. The goal is **full supported authorized operator control**; unsupported functions are
never guessed and stay capability-gated pending spike (§5).

## 5. Sessions and core SDK access (PROPOSED)

Operators need the **full core SDK operator surface through a composable client**, not a fixed
submit-only wrapper:

```
pi-durable sessions create --project <project-id> [--profile <name>]
pi-durable sessions inspect <conversation-id>
pi-durable sessions list
pi-durable sessions fork <conversation-id> --at <entry-id>
pi-durable sessions configure <conversation-id> [--model ...] [--extensions ...]
pi-durable sessions reset <conversation-id> [--handoff-file <f>]
pi-durable sessions compact <conversation-id> [--instructions <t>]
pi-durable sessions transcripts <conversation-id> [--follow]
pi-durable sessions tools <conversation-id>
pi-durable sessions tasks <conversation-id>
pi-durable sessions abort <conversation-id>
pi-durable sessions retry <conversation-id> --task <task-id>
pi-durable sessions usage <conversation-id>
pi-durable sessions reload
```

`sessions create` takes a **project id** (not an existing conversation id) and **returns a
runtime-generated `conversationId`**. Any operator-supplied alias support is **separate and later**;
we never claim a chosen Pi ID.

**Runtime core vs proposed wrapper.** These two layers must stay distinct:

- **Runtime core methods** are the real upstream package surface (`Harness.open`, `submit`,
  `fork`, `reset`, `compact`, `abort`, `waitForTask`, `retryTask`, `usage`, `watch`,
  `watchEvents`, `watchTaskGraph`, `configure`, `inspect`, `createConversation`). These are
  verified upstream names recorded in the research corpus.
- **Proposed wrapper semantics** are our CLI/protocol naming and guarantees. They are aspirational
  and must not be presented as upstream behavior.

Entries that exist upstream but are not yet confirmed for our host remain **capability-gated
pending spike**: the client advertises them only after an evidence gate passes. Unsupported entries
fail closed with a clear capability error rather than guessing.

## 6. CLI envelope, codes, and streaming (PROPOSED)

Every command accepts global `--json`. Without it, output is human text on stdout. With it, stdout
is a **single stable versioned envelope**:

```json
{
  "schemaVersion": "pi-durable.client/v1",
  "requestId": "req-01J...",
  "result": { "kind": "project.created", "projectId": "prj-..." },
  "error": null,
  "artifacts": [
    { "kind": "description", "path": "/abs/description.md", "sha256": "..." }
  ]
}
```

On failure `result` is null and `error` carries `{ code, message, retryable }`. `pi-durable
version`, `--help`, and `pi-durable schema` are read-only and emit the schema without contacting
the service beyond a version handshake.

- **Request-id** is caller-supplied and idempotent: a retried id returns the **original admission**,
  not a new job. A retried id with a **mismatched payload is a conflict**, not a silent overwrite.
- **stdout is data, stderr is diagnostics.** Never mix them; scripts must be able to parse stdout.
- **Exit codes:** `0` success; `2` usage/schema error; `3` capability-gated/unsupported; `4`
  conflict (idempotency mismatch); `5` state error; `6` timeout of a bounded wait; `7` internal.
- **JSONL events** (`--follow`) are one JSON object per line for progress; the final envelope is
  still emitted once. Plain `--json` emits **one stable versioned envelope**; `--follow` emits a
  **JSONL event stream followed by one terminal record**.

**Waits vs cancellation.** A `wait --timeout` is a **bounded wait**, not job cancellation: on
timeout the assignment keeps running and the CLI exits `6`. Cancelling a wait never cancels a job.
Only `assignments abort`/`sessions abort` request job cancellation, and even then the operator must
confirm child processes and leases are released (see §8).

**Reconnect vs replay.** A client that reconnects starts from the **current committed snapshot at
the point of attachment** and then receives **subsequent commits**. Pi watches deliver the current
value plus later commits; we must **not claim Pi replays historical events**. Historical inspection,
if needed, is a **separate stored-transcript query** that reads transcripts as data.

**Paginated outputs** emit `{ items, nextCursor }`; large artifacts are referenced by absolute
path plus content hash, never inlined when they would exceed a bounded envelope size.

## 7. State enums and evidence (PROPOSED)

Explicit states only; **absence or unknown is never success**.

- **project**: `preparing` → `ready` | `error`.
- **assignment (normal)**: `queued` → `running` → `needs_review` → `accepted`.
- **assignment (side states from `running`)**: → `failed` | `incomplete` | `cancelling` | `blocked`.
- **`cancelling` → `cancelled`** only after **processes are stopped and the lease is reconciled**
  (§8). A request to cancel is not itself `cancelled`.

**`blocked` (operator review required).** An assignment is `blocked` when it cannot be safely
continued or re-run without human review. The failure reason is carried in `stopReason`; the
durable-command reason is **`in_doubt_command`**: a previous daemon boot ended while a command
process group was recorded, so an external command **may have executed before its result was
committed**. The writer lease is **retained**. Such rows are **never auto-rerun**; recovery is an
explicit operator/CTO review (checkpoint + diffs) that then aborts or spawns a **new bounded
assignment**. Aborting a `blocked` row whose recorded group is **still alive** is **refused**.

**Error and stop states are explicit and coherent.** `failed` is a worker/tool error;
`incomplete` covers **context-length stop** and **budget exhaustion**; `cancelling` is a
transitional state, not terminal. Absence or unknown is never success, and a stop condition
(context/budget) always maps to an explicit state, never a silent success.

**Codex alone records `accepted`**, after reviewing evidence. A worker never self-accepts; a
**worker completing does not auto-accept**, and a finished-looking summary is not acceptance.

**Review checkpoint requirements.** A checkpoint must capture the **accepted changes including new
UNTRACKED files**, a **diff against a chosen baseline** (git alone misses untracked files in an
unborn repo), and test evidence including **exit codes and content hashes**. A bare `git diff` is
insufficient.

**Test evidence** is bound to project id, assignment id, and **checkout revision or content hash**,
so evidence for one revision cannot be mistaken for another. `wait` returning is not acceptance; it
is only an observation that the assignment left `running`.

**Abort confirmation** covers **child processes and leases**, not rollback. Confirming abort means
the process tree is stopped and the writer lease is released; it explicitly does **not** promise that
filesystem changes are undone.

## 8. Socket, authorization, and safety (PROPOSED)

**Socket path policy.** Unix domain socket paths have a hard length limit (about 104 bytes on
many platforms), and workspace paths can be long. The service therefore uses a **short private
local socket path** under an owned directory (for example a per-user runtime dir), not a path
derived from the project root. Directory and socket are created with owner-only permissions; a
**stale socket is validated as dead before unlink**, never blindly removed.

**Authorization.** Local only. There is no CLI credential on the command line and **no credentials
in argv** for **WORKER/tool subprocesses** (they leak into process listings and shells). The
**trusted service** resolves credentials **privately** through its credential resolver; it never
renders the key into a worker/tool subprocess environment or command line. The service itself may
hold the resolved key in memory.

**No general arbitrary host exec endpoint.** The protocol must not expose a "run anything on the
host" RPC. Extensibility runs through **trusted supported host SDK operations** with an explicit
allow-list. This keeps the socket a narrow, auditable control surface rather than a remote shell.

**Concurrency.** Two clients may share one service: one service, one store, **one writer**. Reads
may overlap; writes serialize through the service. Clients never open the store directly.

## 9. Related documents

- `PLAN.md` — authoritative scope and source facts.
- `docs/IMPLEMENTATION-AND-ACCEPTANCE.md` — implementation detail, data ownership, and acceptance
  test matrix. All runtime tests there are marked **NOT RUN**.
