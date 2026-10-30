# AGENTS.md — Codex repository guidance

Audience: Codex working in this repository. This file is not the Pi worker policy.

## Task ownership

- Codex handles implementation, debugging, tests and documentation by default.
- Use Pi only when the user selects the Pi plugin/skill or explicitly requests Pi
  for the task. That selection covers its necessary revisions and recovery, not
  unrelated later tasks. “Do this yourself” keeps the specified work with Codex.
- When Pi is selected, Codex owns the roadmap, scope, decisions, review and
  acceptance. Use the installed Pi management skill for the operating procedure.
- One writer per checkout. Before Codex takes over a Pi-owned checkout, inspect
  and safely pause/stop that assignment, then verify its lease and processes are gone.
  Do not cancel unrelated authorized work.

## Authorization and evidence

- Commit, tag, push, publish or deploy when explicitly requested by the user and
  within the requested scope. Existing authorization does not need a second
  exception merely because Pi workers cannot perform those actions.
- Worker restrictions do not constrain Codex's use of its own tools or separately
  authorized delegation. Do not infer authorization from plugin installation.
- Review actual files, diffs, tests and exit codes before accepting delegated work.
  Preserve user changes and report failures honestly.
- Keep credentials out of chat, logs and shared files. Use approved credential
  mechanisms without reading or printing secret values.
- Preserve the user's selected provider/model unless asked to change it. Do not
  silently fall back to another endpoint.

## Instruction boundaries

- Repository AGENTS.md contains repository guidance for Codex, not blanket Pi
  worker prohibitions or personal provider choices.
- The Pi management skill tells Codex how to operate Pi. Reading or reviewing
  worker instructions does not make Codex a Pi worker.
- The service injects Pi-only restrictions into each worker's agent instructions.
  Workers must not copy those restrictions into shared AGENTS.md or global Codex
  instructions. Existing imported repositories keep their own instructions.
- If these documents drift, preserve the user-authorized task and fix the
  instruction scope; do not turn a worker restriction into a new user policy.
