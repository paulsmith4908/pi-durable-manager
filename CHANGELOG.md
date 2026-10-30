# Changes

## 0.7.0-beta.3 — security, recovery and operator permissions

- Protect Settings with private operator authority; public viewers cannot mutate settings.
- Apply one secret-path policy across file tools, shell, evidence and checkpoints.
- Restore pending wake timers after restart, allow correction after stale acceptance, and bound mixed large transcript pages.
- Pin runtime dependencies and add guarded inspect/upgrade/repair/rollback plus macOS CI.
- Add provider rename, credential rotation/revocation, crash cleanup and revision-bound readiness.
- Add paginated recorded output/assignment history and actual session model labels.
- Add audited default/project worker permissions with assignment policy snapshots. Stop automatic AGENTS.md creation; existing user files are preserved.
- Make setup refresh resumable and distinguish installation from provider and GUI-wake verification.
- Additional release and viewer acceptance details are recorded with the candidate validation receipts.

## 0.7.0-beta.2 — separate Codex and Pi instruction scopes

- Codex repo guidance permits explicitly user-requested Git and release actions.
- Pi-only restrictions stay in worker agent instructions, including continuations
  and custom session instruction updates.
- Manager/setup skills identify their Codex audience; generated repos no longer
  inherit worker prohibitions or a personal model connection.
- Regression checks cover instruction delivery, imported repo preservation and
  template/skill packaging consistency.

## 0.7.0-beta.1 — prepared macOS sharing release

- Clean repository marketplace with the complete, checksum-verified plugin payload.
- One agent-readable install guide and a short friend-facing quickstart.
- Guided private setup, multiple OpenAI-compatible providers/models, default model
  and project overrides; existing sessions remain pinned without silent fallback.
- Simplified Settings with collapsed setup and compatibility details.
- Existing durable workflow, questions, native GUI wakes, actual Pi terminal,
  working briefs, host validation and activity scorecard.
- Repeatable clean archive installation check and explicit beta limitations.

Initial public testing beta. Actual Modal use and generic transport fixtures
have been tested on the development Mac. No second-physical-Mac, llama.cpp/oMLX
server, public-directory, unattended-upgrade, or sleep/reboot guarantee is claimed.
