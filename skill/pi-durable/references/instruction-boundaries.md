# Instruction boundaries

Audience: Codex operating Pi. This reference describes worker restrictions; it does not
apply them to Codex.

| Location | Audience | Responsibility |
| --- | --- | --- |
| Repository AGENTS.md | Codex | Repo conventions, user-authorized actions, task ownership |
| This plugin/skill | Codex manager | Submit, observe, answer, review and recover Pi work |
| Service-injected agent instructions | Pi worker only | Assigned code/tests, no onward delegation or independent release actions |

The service's `worker-instructions` module supplies the Pi worker policy on assignment
admission/continuation and on custom session instruction updates. A worker cannot obtain
Codex's publishing permissions merely by reading AGENTS.md. Conversely, Codex reading a
worker transcript or policy is reviewing evidence, not adopting that worker role.

Do not put worker-only restrictions in shared AGENTS.md. New projects receive only the
Codex repository template. Importing a project does not rewrite its existing instructions.
If an older generated AGENTS.md has mixed roles, explain its provenance and scope and
update it when authorized; never silently rewrite arbitrary user-authored instructions.

Worker release restrictions are prompt instructions, not a claim of a universal command
filter. Sandbox/tool permissions and one-writer leases remain separate enforcement.
For a user-requested release, review and settle the worker, then Codex performs the
requested Git/release operation itself. No additional policy exception is needed solely
because the worker is prohibited from doing it.
