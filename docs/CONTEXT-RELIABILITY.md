# Worker context reliability

The manager adapter bounds the amount of source and command output placed in a
worker's context. This is not an execution deadline or a replacement model.

- `read` defaults to 200 lines and at most 12 KiB. Larger reads return an explicit
  byte cursor and SHA-256. Continue with `byteOffset` and `expectedHash`; a changed
  file is refused so pages from different versions cannot silently be combined.
  Very long UTF-8 lines remain accessible. Explicit line ranges are supported.
- Worker bash output retains a 16 KiB tail; the existing full-output artifact
  mechanism preserves larger output for deliberate inspection.
- Compaction remains upstream Pi Durable. The adapter reserves the configured
  output capacity plus a small safety margin, keeps a bounded recent tail, and
  disables overlapping background compaction. Blocking/overflow compaction still
  operates. `service.status` reports the effective policy and token limits.
- Successful tool results update an assignment-scoped, bounded durable activity
  checkpoint: recent read paths/ranges/hashes, repeats and successful edits.
  Before each model request the adapter supplies these observations again, so
  compaction does not erase them. It uses no additional model request and does
  not inject a new task, implement code, or claim tests passed.
- Repeated identical reads without successful edits produce automatic guidance
  to resume the next concrete step. The supervisor labels this `read_loop` instead
  of treating activity as proof of implementation. If repetition persists, one
  manager event per edit epoch requests diagnosis; it never cancels a command or
  starts a second writer. Existing bounded delivery reminders still apply.

The checkpoint is deliberately not a complete semantic memory. Reads through
shell commands are not classified as `read`, and shell writes are not inferred
as successful edits. Read-only investigation can legitimately involve repeated
reads; the signal is a warning, never a requirement to modify files. Models can
still make poor decisions. Actual source, tests and acceptance remain necessary.

Daemon code updates require a safe tool-boundary pause, checkpoint review and a
quiescent service restart, followed by explicit workflow continuation. Closing a
viewer is never a reason to stop work. No provider/endpoint change is needed.
