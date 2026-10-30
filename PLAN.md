# PLAN.md — Pi Durable Manager (core plan)

Status: **historical planning baseline, updated for the 0.3.0-beta.1 friend-friendly beta.**
Companion documents [`docs/OPERATOR-CONTRACT.md`](docs/OPERATOR-CONTRACT.md) and
[`docs/IMPLEMENTATION-AND-ACCEPTANCE.md`](docs/IMPLEMENTATION-AND-ACCEPTANCE.md) describe the
protocol/acceptance contract. This file is intentionally focused; exhaustive protocol,
data-dictionary, and test matrices live in those companions. **Historical note:** the "documentation
only / NOT RUN" framing below was true at plan time; the product is now built and its full suite is
run on this machine (see `README.md` and `docs/IMPLEMENTED.md` for current status). The plan text is
retained for context — where it disagrees with the shipped product, the **product and its docs
win**.

**Shipped since this plan (0.3.0-beta.1).** The following are now implemented, superseding the
non-goals listed below:
- A **guided setup** command (`pi-durable setup`) — interactive + scripted, with discovery/validation
  and a private 0600 config carrying a **credential reference only**.
- A **skills-only portable Codex plugin** (`plugin/`) installed via `scripts/install-plugin.mjs`
  (no MCP), alongside the standalone skill installer.
- A **read-only loopback monitor** (`tools/monitor.mjs`).
- **Automatic manager wake** (event mode) via the documented native `codex queue` CLI — code-only,
  zero model calls while state is unchanged, at-least-once with durable dedup (no exactly-once
  claim).
- An **end-to-end `check`** command with honest PASS/FAIL/SKIP offline (fixture) and online (real
  inference + wake) modes.
- A **friend-friendly beta quickstart** (`docs/BETA-QUICKSTART.md`).
- Even with the above, the plan's hard boundaries still hold: **no publication/deploy**, **no MCP
  server as a dependency**, **no raw-key handling**, **local processes + Modal inference only**.

## 1. Outcome and non-goals

**Outcome.** Give a single operator a durable local service plus CLI/scriptable client—and a short
Codex skill—that supplies *external subagents* for all implementation, debugging, testing, and
documentation work. Codex remains the native desktop GUI CTO: it plans and reviews, never
implements. A plain-language request becomes a local Git repo, a Pi project registry entry, worker
conversations, code and tests, and a Codex review of the *actual diff and evidence*, followed by
revision loops that can resume durably after compaction or a new chat.

**Non-goals (this plan and the product scope).**
- No MCP server, no Decisions subsystem, no automatic commits, merges, pushes, deploys, or GitHub
  operations. (A read-only local browser **monitor** and automatic **manager wake** via the native
  `codex queue` CLI are now implemented — see the update note above.)
- No application implementation in this assignment. No Pi installation, no model probes.
- No inference change: stay on the existing Modal `deepseek-ai/DeepSeek-V4.1-Flash`
  OpenAI-compatible `/v1` endpoint with no fallback, referenced by private credential handle only.
- Codex does not implement during bootstrap either; existing Modal/OpenCode workers do the work.

**Trust caution.** The existing controller connection tested 2026-10-23 does not prove Pi works.
The provider spike in M1 must produce real evidence before any cutover is considered.

## 2. Architecture diagram and boundaries

```
 [Operator natural language]
        |  user plain-language project
        v
 [Codex desktop GUI = CTO: plans + reviews, does NOT implement]
        |  short skill + scriptable client (no MCP)
        v
 [Pi Durable local service] --- restricted authenticated Unix socket
        |        |
        |        +-- SQLite store (one writer per store)
        |        +-- project registry / assignment journal (application metadata)
        v
 [Pi conversations] --- worker threads, durable transcripts
        |
        +-- Modal inference (/v1, pinned model, no fallback)
        +-- sandboxed workspace tools (project checkout)
        |
        v
 [Local Git repo checkout] --> diff + test evidence --> Codex review
        --> revisions --> durable resume after compaction / new chat
```

**Direction note.** The diagram reads GUI → skill/client → local service → Pi conversations →
Modal inference + sandboxed workspace tools. It is **not** service → client → workers: the service
is the durable control plane; clients and the GUI drive it, and Pi conversations are where workers
actually run.

**Hard boundaries.**
- One writer per SQLite store. Clients never open the DB as another writer; they speak the
  versioned protocol over the restricted, authenticated Unix socket.
- The service is supervised with recovery; the socket is restricted and authenticated.
- Enforcement of filesystem/process/network limits is mandatory and meaningful. `cwd` and
  `NodeExecutionEnv` are **not** a sandbox and must not be treated as one.
- Runtime credentials are isolated from workers; no keys in prompts or logs.
- SQLite gives crash recovery, **not** arbitrary exactly-once shell effects. Request cancellation
  is **not** confirmation of process stop; cancelling a wait is not cancelling a job.
- Unborn Git `main` cannot assume worktrees until a base commit is explicitly available; no
  automatic initial commit.
- Codex native manager GUI sessions are separate from Pi sessions; Pi state is the source of truth
  for worker/resume identity.

## 3. Repo and runtime layout proposal

Monorepo, Node/TypeScript targeting the pinned upstream release (upstream `main` is 1.4.0 with
`node>=22.19.0`, experimental). Layout is a proposal; exact paths land in the companions.

```
pi-durable-manager/
  PLAN.md                     # this core plan
  README.md                   # existing scaffold (preserved)
  AGENTS.md                   # existing scaffold (preserved)
  docs/
    OPERATOR-CONTRACT.md
    IMPLEMENTATION-AND-ACCEPTANCE.md
  packages/
    protocol/                 # shared versioned request/response types + schema
    service/                  # durable local service (socket owner, sole store writer)
    store/                    # application SQLite access, migrations, one-writer guard
    cli/                      # text + JSON CLI
    client/                   # composable script API over the protocol
    skill/                    # short Codex skill + on-demand references
```

Note: our `packages/store` is **our** application metadata store; it is distinct from Pi's own
owned storage (Pi creates and migrates its own tables). The chosen integration is a **separate
application-metadata SQLite database owned by the SAME service process**, reconciled with Pi's
storage through an explicit request journal / reconciliation using Pi IDs — not one shared
transaction. See [`docs/IMPLEMENTATION-AND-ACCEPTANCE.md`](docs/IMPLEMENTATION-AND-ACCEPTANCE.md) §2.

Runtime: a supervised service process owns the Unix socket and the SQLite store; CLI and script
client connect over the socket. Per-project checkouts are local Git repos with one writer each.

## 4. Data model and state lifecycle

Entities (authoritative detail in `docs/IMPLEMENTATION-AND-ACCEPTANCE.md`):

- **project** — registry entry bound to one local Git repo/checkout; distinct from a conversation;
  one writer per checkout. Creation/import is an idempotent journal: no overwrites, no automatic
  initial commit.
- **profile** — operator/worker configuration and credential *references* (never raw secrets).
- **conversation** — a worker thread; owns prompts and turns. A prompt fork is **not** a
  filesystem fork.
- **assignment** — one unit of delegated work with explicit acceptance criteria and evidence refs.
- **request** — a submitted job (submit/steer/follow-up/fork actions) with lifecycle states.
- **artifact** — produced files, diffs, and test outputs referenced by ID.
- **review checkpoint** — Codex verdict + evidence snapshot enabling durable resume.

**Lifecycle.** project -> conversation -> assignment -> request -> (worker runs) -> artifacts ->
review checkpoint -> revision requests or acceptance. Worker errors, context-length limits, and
budget exhaustion become **explicit incomplete states**—never silent success. Resume reattaches
using persisted IDs, acceptance criteria, and evidence, so a compacted or new Codex chat can
continue without redoing research.

## 5. Project-to-review user journey

1. Operator states a project in plain language.
2. Codex creates or imports the local Git repo and registers a Pi project (idempotent; no overwrite).
3. Codex opens a worker conversation from the short skill and submits an assignment with explicit
   acceptance criteria; credentials are referenced, not embedded.
4. A worker (coding/testing/doc) executes inside enforced filesystem/process/network limits and
   produces a diff plus test evidence as artifacts.
5. Codex inspects the **actual diff and evidence**, not summaries, and records a review checkpoint.
6. Codex issues revisions (steer/follow-up/fork) or accepts. After compaction or a new chat, Codex
   reattaches from persisted IDs and continues.
7. No step commits, merges, pushes, deploys, or touches GitHub automatically.

## 6. Phased milestone roadmap

Each phase lists deliverables, exit criteria, and dependencies. Detailed bounded tasks and evidence
artifacts live in [`docs/IMPLEMENTATION-AND-ACCEPTANCE.md`](docs/IMPLEMENTATION-AND-ACCEPTANCE.md) §5.

**M0 — Docs and scope freeze.** Deliverables: this core plan; companions
(`docs/OPERATOR-CONTRACT.md`, `docs/IMPLEMENTATION-AND-ACCEPTANCE.md`); release-pin **TODO**
recorded. Exit: companions exist; **verified registry release pin remains an implementation gate
(TODO), not evidence already obtained**. Depends on: nothing.

**M1 — Provider spike (evidence gate).** Deliverables: a spike checking the actual SDK package
compatibility and tool-use streams, reasoning, cancellation, and context behavior against the
existing Modal endpoint (no fallback). Exit: written pass/fail evidence on the real endpoint.
Upstream `main` was **observed** at 1.4.0 / `node>=22.19.0`; the verified registry pin is still a
**TODO**, not a completed test. Depends on: M0. Blocks: everything downstream.

**M2 — Protocol and store.** Deliverables: shared versioned protocol package; application store
package with migrations, one-writer guard, and crash-recovery tests. Exit: a **minimal service
harness/test client** exercises the store **only** through the service; no second writer; recovery
tests pass. Full CLI arrives in M4. Depends on: M1.

**M2b — Project/assignment lifecycle.** Deliverables: idempotent project create/import journal,
crash reconciliation, `preparing/ready/error` and `queued/running/needs_review/accepted/failed/
incomplete/cancelling/cancelled` state machines, evidence binding to checkout revision/content hash,
and lease handling across crash/reconcile. Exit: partial-failure recovery and conflicting-writer
rejection pass. Depends on: M2. Blocks: M3.

**M3 — Service, socket, supervision.** Deliverables: restricted authenticated Unix socket, service
supervision/recovery, and enforced filesystem/process/network restrictions (explicitly not relying
on `cwd`/`NodeExecutionEnv`). Exit: unauthorized callers rejected; service restarts and resumes.
Depends on: M2b.

**M4 — Operator control surface.** Deliverables: full supported inspection/control operations—
create, list, inspect, submit, steer, follow-up, fork, configure, reset, compact, handoff,
transcript, tools, tasks, abort, retry, usage, reload—plus a composable script API distinct from
runtime core methods. Exit: every operator action works via CLI (text + JSON) and script client.
Depends on: M3.

**M5 — Codex skill and resume.** Deliverables: short Codex skill referencing on-demand docs;
reattach flow using persisted IDs/criteria/evidence; native manager GUI sessions kept separate from
Pi sessions. Exit: resume works after a simulated compaction/new chat. Depends on: M4.

**M6 — Bootstrap, cutover, rollback.** Deliverables: bootstrap using existing Modal/OpenCode
workers (Codex does not implement); real code/test/revision gate; cutover to Pi; retained old
controller for rollback; project/repo `AGENTS.md` migration at cutover. Exit: gate evidence
recorded; rollback rehearsed. Depends on: M5.

## 7. Bootstrap, cutover, and rollback

**Bootstrap.** Existing Modal/OpenCode workers implement Pi Durable Manager; Codex remains the
native GUI **CTO role** (plans and reviews, never implements). No Pi installation is required to
bootstrap. The bootstrap environment is a temporary controller, not the target.

**Cutover gate.** Cut over to Pi only after a real code/test/revision cycle has passed: code written
by workers, tests executed with evidence, and at least one Codex-driven revision cycle completed.

**Rollback.** Keep the previous/old controller functional throughout; cutover is reversible. Rollback
is **not** a "no data loss" guarantee: it **pauses and releases leases**, **preserves uncommitted
files**, **backs up state**, and requires **compatibility checks** before switching back. Migrate
project/repo `AGENTS.md` at cutover as required.

## 8. Risks and default decisions

| Risk | Default decision |
|---|---|
| Unproven Pi/provider behavior | Block on M1 evidence; do not trust the 2026-10-23 controller test |
| Accidental exactly-once assumptions | Treat SQLite as crash recovery only, not exactly-once shell effects |
| Cancellation mistaken for process stop | Document that cancel-wait != cancel-job; confirm process state |
| Sandbox overconfidence | Enforce filesystem/process/network limits; `cwd`/`NodeExecutionEnv` are not sandboxes |
| Secret leakage | Credentials isolated; private references only; never in prompts/logs |
| Premature Git assumptions | No worktrees until a base commit exists; no automatic initial commit |
| Scope creep | No MCP, Decisions, dashboard, external API, or auto-wakeups |
| Model drift | Pin the existing Modal DeepSeek-V4.1-Flash `/v1` endpoint; no fallback |

## 9. Companion documents (present)

- [`docs/OPERATOR-CONTRACT.md`](docs/OPERATOR-CONTRACT.md) — operator-facing operations, states,
  and guarantees.
- [`docs/IMPLEMENTATION-AND-ACCEPTANCE.md`](docs/IMPLEMENTATION-AND-ACCEPTANCE.md) — implementation
  detail, data ownership, milestone tasks, and acceptance/test matrix.

## 10. Sources appendix

Public primary sources (what was verified vs open, per source):

- **Durable package README** —
  <https://github.com/earendil-works/pi/blob/main/packages/durable/README.md>. Verified: durable
  conversation/task runtime, `Harness`, SQLite/JSONL storage, `submit`/`fork`/`reset`/`compact`/
  `abort`/`retryTask`/`usage`, watches, one-writer-per-storage. Open: our host-specific wrapper
  semantics.
- **`@earendil-works/pi-durable` package manifest** —
  <https://github.com/earendil-works/pi/blob/main/packages/durable/package.json>. **Observed
  upstream version 1.4.0**, `engines.node >=22.19.0`, experimental. The **verified registry release
  pin remains a TODO implementation gate (M0/M1), separate from the observed version and not
  already-tested evidence**.
- **Durable design spec** — <https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md>.
- **`@earendil-works/pi-ai` README** —
  <https://github.com/earendil-works/pi/blob/main/packages/ai/README.md>. Provider/SDK and tool-use
  behavior; npm package `@earendil-works/pi-ai`. Open: our Modal endpoint behavior pending the M1
  spike.
- **OpenAI Codex skills documentation** — <https://developers.openai.com/codex/skills/>. Verified:
  skill authoring references. Open: exact install paths in this workspace.

Core methods are used throughout; Cloudflare-wrapper specifics are intentionally not relied upon.

## 11. Remaining implementation decisions / evidence gates

These are **evidence gates, not completed work** — no fake claims:

- **Verified released package versions + precise core API signatures** must be captured (M1).
- **Provider compatibility**: required compat flags, context-window handling, and compaction
  behavior must be proven against the real endpoint.
- **macOS sandbox implementation** must be chosen and must **prove containment** (symlink/fail-closed
  tests).
- **Socket framing, version handshake, and paths** must be specified and **schema-validated early**
  in M2/M3.
