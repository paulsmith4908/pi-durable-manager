# IMPLEMENTATION-AND-ACCEPTANCE.md — implementation detail, data ownership, acceptance matrix

Status: **PLANNING DELIVERABLE. NO RUNTIME WORK PERFORMED.** All product/runtime tests described
here are **NOT RUN**. This file records *how* the system would be built and *what evidence* would
prove it, so a future implementer and reviewer share one definition of done. Documentation checks
only in this assignment.

Companion to `PLAN.md` (authoritative scope/source facts) and `docs/OPERATOR-CONTRACT.md`
(command/protocol contract).

## 1. Repository layout (proposed)

```
pi-durable-manager/
  PLAN.md
  README.md                       # existing scaffold (preserved)
  AGENTS.md                       # existing scaffold (preserved)
  docs/OPERATOR-CONTRACT.md
  docs/IMPLEMENTATION-AND-ACCEPTANCE.md
  packages/
    protocol/    # versioned request/response types + JSON schema
    service/     # durable local service (socket owner, sole store writer)
    store/       # our SQLite access, migrations, one-writer guard  (OUR package)
    cli/         # text + JSON CLI
    client/      # composable script API over the protocol
    skill/       # short Codex skill + on-demand references
```

## 2. Data ownership: Pi vs application metadata

The distinction is exact and load-bearing.

- **Pi owns its own storage.** The upstream durable package creates and migrates its tables
  (entries, documents, tasks, usage) inside the storage it is given. We never write Pi's tables by
  hand.
- **The application owns its metadata** (project registry, assignment journal, review checkpoints,
  evidence index). This is **our** schema.
- **Architecture decision (chosen).** The application metadata lives in a **separate application
  SQLite file owned by the SAME service process**, with an **explicit request journal /
  reconciliation** linking application records to **Pi IDs**. Pi's own database is **only touched
  through Pi's supported adapter APIs**; we never open Pi's file as a competing writer.
- **Co-located tables are a deferred alternative, not the primary choice.** Co-location in one
  SQLite database via Pi's supported table prefix + shared transaction facade is a possible future
  design; it is **not** the unresolved primary architecture and not required now.
- **Backups.** Backups are **consistent quiesced snapshots of both stores** (application metadata
  and Pi storage) taken while writers are paused. We do **not** claim any **cross-store atomic
  commit**: the two stores are reconciled via the request journal, not one shared transaction.
- Application writes go through our store's transaction (or Pi's supported adapter APIs) — never a
  raw competing writer.
- **Schema changes, backups, and ABI pinning:** the application schema is versioned and migrated by
  our store package. Backups must capture both Pi storage and application tables consistently.
  We pin the source definitions and the running code to the same release; a mismatch between pinned
  ABI and running code is a hard doctor failure, not a warning.

## 2a. Required registry and assignment fields

**Project registry (required):** `id`, `slug`/`name`, `canonicalRepo`/`allowedRoot`, `profile`,
and `state`/`journalIdentity` (the idempotency key tying the project to its creation-journal entry).

**Assignment (required):** `id`, `projectId`, `conversationId`, `requestId`, `taskRef`/`criteriaRef`
(the persisted Codex-owned manifest), `checkoutLease`, `state`, and `evidenceRef`/`checkpointRef`.

**Missing or corrupt metadata.** If required metadata is missing or corrupt, the service **blocks
and reconciles**; it **never silently creates a duplicate** project or assignment. Reconciliation
repairs or rolls forward the affected journal entry, or fails closed with an explicit error.

## 3. Local runtime layout: config, state, secrets

- **Source/runtime separation.** Source checkouts live under project roots; runtime state (socket,
  store, journals, logs) lives under a private per-user runtime directory. An **active service never
  silently reloads half-written source**; reload is an explicit, announced operation.
- **Service credential resolver** reads an **existing credential reference** and injects the key
  server-side. The key is **never passed into a tool subprocess environment**.
- **Inference vs tools.** The **host Pi provider handles model inference** (the pinned Modal
  endpoint). **Sandboxed tools run separately** in the workspace. Only Modal model inference is
  allowed for inference routing; package installs and test servers that need network during
  development are governed by **separate network permissions** and are not implied to be limited to
  Modal. Do not describe all development network access as Modal-only.
- **Enforcement.** Both project file wrappers and the shell process path are enforced, with
  **symlink tests**. If a sandbox capability is unavailable, the system **fails closed**.

## 4. Compatibility-first test order

Tests run in this order, cheapest and most deterministic first:

1. **Schema** round-trip (create/read/write a small document and entry).
2. **Small tool** call end-to-end.
3. **Streaming reasoning** deltas.
4. **Multi-turn tool replay** (rerun after simulated crash finds the same child/submission).
5. **Cancel** behavior (abort releases children and leases).
6. **Missing/invalid credentials**.
7. **Model selection** binding to the pinned endpoint.
8. **Context/compaction** behavior including overflow retry.
9. **Output limits** and truncation.

A **fake provider** is used for deterministic tests, but it is **NEVER a production fallback**. A
**real-model gate** is required before cutover. Upstream `main` was **observed at 1.4.0 with
`node>=22.19.0`**; a **verified registry release pin remains an M0/M1 implementation-gate TODO and
is NOT already-tested evidence**.

## 5. Milestones, tasks, dependencies, evidence

Each task is bounded and names its evidence artifact.

**M0 — Docs and scope freeze.** Tasks: write the three docs; record the release pin TODO; mark all
runtime tests NOT RUN. Evidence: the docs themselves + link/word-count check. Depends on: nothing.

**M1 — Provider spike (evidence gate).** Tasks: install the pinned package in a throwaway dir; run
schema/read/write, small tool, streaming reasoning, multi-turn replay, cancel, missing-cred,
context/compaction, output-limit probes against the real Modal endpoint. Evidence: a written pass/
fail report with raw outputs. Depends on: M0. **Blocks: all downstream.**

**M2 — Protocol + store.** Tasks: protocol package; store package with migrations, one-writer guard,
crash-recovery tests. Exit: **tested via a minimal service harness / test client** — CLI text/JSON
and script client talk to the store **only** through the service; no second writer; recovery tests
pass. M2 does **not** depend on full production clients. Evidence: recovery test logs; schema diff.
Depends on: M1.

**M2b — Project/assignment lifecycle.** Tasks: idempotent project create/import journal, crash
reconciliation, `preparing/ready/error` and `queued/running/needs_review/accepted/failed/incomplete/
cancelling/cancelled` state machines, evidence binding to checkout revision/content hash, lease
handling across crash/reconcile. Exit: partial-failure recovery and conflicting-writer rejection
pass. Evidence: recovery/conflict test logs. Depends on: M2. **Blocks: M3.**

**M3 — Service, socket, supervision.** Tasks: restricted authenticated Unix socket; supervision;
enforced fs/process/network limits with symlink and fail-closed tests. Evidence: rejection tests +
restart/resume transcript. Depends on: M2b.

**M4 — Operator control surface.** Tasks: full supported operations + composable client. This is
where the **full production client** is delivered. Evidence: CLI (text+JSON) transcript per
operation. Depends on: M3.

**M5 — Codex skill and resume.** Tasks: short skill; reattach from persisted ids/criteria/evidence;
keep native GUI sessions separate from Pi sessions. Evidence: resume after simulated compaction/
new-chat transcript. Depends on: M4.

**M6 — Bootstrap, cutover, rollback.** Tasks: bootstrap on legacy Modal/OpenCode workers; real
code/test/revision gate; cutover; rollback plan; `AGENTS.md` migration. Evidence: gate evidence +
rollback rehearsal log. Depends on: M5.

## 6. Project/assignment lifecycle and recovery

- **Partial-failure recovery.** `create`/`import` write an idempotent journal entry before touching
  the filesystem. A crash mid-create leaves a `preparing` project that reconciliation can finish or
  roll forward; it never yields two projects or a half-overwritten checkout.
- **Fresh unborn repo.** A newly `git init`-ed repo has **no commit and no remote**. The repo has a
  **serial writer** (one writer per checkout). There is **no automatic initial commit**.
- **Future worktrees** may be added only once an **existing committed ref** is present, and never by
  creating a **hidden commit**. `cwd` alone is **not** an actual sandbox.
- **Leases survive crash and reconcile before a second writer** can take the checkout. A second
  writer waits for reconciliation; it is never allowed to run concurrently.

## 7. Codex skill: install, discovery, permissions

- Install two ways: **repo copy** (committed in the project) or **user-level install**, resolved
  through permission-aware paths.
- Existing parent `.agents/` and `.codex/` directories are **protected** — never overwritten or
  removed.
- A skill **grants no extra permissions**; it only documents how to use the local service/client.
- Update the **current `AGENTS.md` instructions from Modal/OpenCode to Pi only on accepted
  cutover** — not before.
- A client invoked through the GUI's **existing shell tools is not a replacement Codex CLI
  manager**, and **no extra OpenAI API manager key is needed** for it.

## 8. Acceptance matrix

Each row names category, scenario, and evidence artifact. **All runtime rows are NOT RUN now.**

| Category | Scenario | Evidence |
|---|---|---|
| Security | No creds in **worker/tool subprocess** argv/env; trusted service resolves reference privately | test log |
| Security | Bash/tool blocked by filesystem sandbox; symlink escape rejected | test log |
| Security | Fail-closed when sandbox unsupported | test log |
| Security | **Untracked code artifact** is contained/captured, not silently ignored | test log |
| Security | **Sandbox dev-network** access is distinct from **service inference** routing | test log |
| Functional | Real disposable **new app** coded + tested end-to-end (Modal inference + Pi) | app diff + tests |
| Functional | **Project create/import** idempotent; **duplicate/conflict payload** rejected, not silently overwritten | error log |
| Functional | Steer mid-run; follow-up starts next run | transcript |
| Functional | Code review + revision loop with checkpoint | checkpoint + diff |
| Failure | Crash/reopen idempotence; same requestId returns original admission | transcript |
| Failure | Abort confirms **child processes + leases**, not rollback | process/lease dump |
| Failure | Conflicting second writer is rejected | error log |
| Failure | Corrupted/missing metadata handled without silent success | error log |
| Failure | Provider failure surfaces as explicit `incomplete` | status dump |
| Failure | Length/budget stops are explicit, not success | status dump |
| Migration | Failed migration rolls back to prior schema | migration log |
| Migration | Context reconciliation across simulated Codex compaction / new chat | reattach transcript |

**Division of labor:** root Codex does architecture and review; workers implement and test. Codex
never implements.

## 9. Rollout

1. **Legacy bootstrap:** Modal/OpenCode workers implement Pi Durable Manager. Legacy controller
   remains functional.
2. **Pi proven:** Pi can write code, run tests, and revise — gated on real evidence.
3. **Pi self-hosted continuation:** Pi drives its own continuation **without modifying the active
   runtime unexpectedly**. **Pi pauses before an alternate worker takes the checkout**; there are
   **no duplicate writers**.

Retain the **legacy rollback** path. Rollback is **not** a data-loss-free guarantee: it
**pauses/releases leases**, **preserves uncommitted files**, **backs up state**, and requires
**compatibility checks** before switching back. **Backup/restore compatibility and socket schema
versions** are verified as part of the gate.

## 10. Status

**Planning done != software done.** Every runtime/functional/security/migration test above is
**NOT RUN**. M0/M1 release-pin verification remains an implementation gate. Documentation checks
only were performed in this assignment.
