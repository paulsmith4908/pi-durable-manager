# Keep Codex and Pi instructions separate

The role receiving an instruction matters more than the file's topic.

| Location | Recipient | Scope |
| --- | --- | --- |
| `AGENTS.md` | Codex in the repository | Task ownership, conventions, evidence, authorized Git/release actions |
| Plugin `SKILL.md` and references | Codex managing a selected Pi task | Delegation, questions, review, wake/recovery protocol |
| `src/worker-instructions.ts` | Pi worker agent only | Assigned code/tests; no independent commit/tag/push/publish/deploy or onward delegation |

`src/codex-repo-guidance.ts` supplies the new-project template. It must match
`AGENTS.md` and `docs/AGENTS-PI-TEMPLATE.md`; tests catch drift. Projects imported
from elsewhere keep their own AGENTS.md unchanged.

`withWorkerPolicy` supplies worker-only instructions on assignment admission,
continuation and custom session configuration. Reading a worker policy or
transcript for review does not change Codex's role. Workers must not copy their
restrictions into shared repo rules. A worker reading Codex's publishing authority
still cannot publish on its own: it asks the manager to handle the restricted action.

These are instruction boundaries, not a claim that natural-language instructions
provide a universal security barrier. The sandbox, protected paths and checkout
leases continue to enforce their separate boundaries.

## Older installations and projects

A plugin update fixes the manager skill; an updated service is required for the
new generated-project template and worker policy. Follow the deliberate runtime
upgrade procedure in INSTALL.md while no workers are active. Existing arbitrary
project instructions are not automatically rewritten. When an older generated
AGENTS.md mixes roles, Codex should identify it and correct the scope with user
authorization, preserving unrelated user conventions. No automatic migration of
private data, endpoints or credentials is part of this change.

## Regression checks

The tests inspect actual provider requests during an initial assignment and an
answered-question continuation, check custom session-instruction updates, ensure
new repos receive only Codex guidance, verify imports preserve existing rules,
and compare distributed templates/skill references for drift.

Run `npm test` before packaging; `npm run release:verify` verifies the actual
bundled runtime and checks the generated repo guidance after a clean install.
