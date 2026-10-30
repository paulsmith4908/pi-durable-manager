# Compatibility

Verified facts about the SDK surface this probe is built against, and how to run it.

## Verified versions

| Package | Version | Notes |
| --- | --- | --- |
| `@earendil-works/pi-durable` | 1.4.0 | `Harness`, `Storage`, entry/submission types |
| `@earendil-works/pi-ai` | 1.4.0 | `Models`, provider registry, faux test provider |
| `@earendil-works/chord` | 1.4.0 | `BackgroundContext` request context |
| Node.js | >= 22.19.0 | `package.json` `engines`; built and tested on v22.22.1 |

## What was exercised locally

- `npm run build` — `tsc -p tsconfig.json`, clean.
- `npm test` — `tsc -p tsconfig.test.json` then `node --test dist-test/tests/*.test.js`,
  **39 passing / 0 failing**.
- The probe tests (`tests/probe.test.ts`) drive the **real** `Harness` over the **real**
  file-backed SQLite storage (`@earendil-works/pi-durable/storage/sqlite/node`) using the
  **real** `@earendil-works/pi-ai/providers/faux` provider. No network call and no real
  credential are used; a fixture key (`sk-…`) is supplied only to prove redaction.

## API notes relied on (pi-durable 1.4.0)

- `Harness.open(storage, options, context): Promise<Harness>`; `options.models` accepts either
  a `Models` catalogue or a `() => Models` factory.
- `Harness#root(context, { agent: { model: { provider, modelId }, instructions } })`.
- `root.submit({ type: "input", requestId, content }, context)` returns a submission whose
  `.id` is stable and whose `.wait(context)` resolves the settled record.
- `root.entries({ order: "ascending" }, limit, cursor, context)` → paginated items.
- `EntryRecord.model` is a **readonly array** of model messages (each entry can contribute
  several assistant/user/tool-result messages). The probe walks the array in order and treats
  the **last** assistant message as terminal.
- Terminal stop reasons are `"pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"`.
  Only `"stop"` counts as a clean finish.

## Running the probe

```
node dist/probe.js --config CONFIG.json [--state-dir DIR] [--timeout-ms N]
node dist/probe.js --legacy-config CONFIG.json --state-dir DIR [--timeout-ms N]
```

- `--config` / `--legacy-config`: exactly one is required.
- `--state-dir`: overrides `paths.stateDir` for **both** forms; required for `--legacy-config`.
- `--timeout-ms`: positive integer, default `60000`.
- Exit code `0` on a clean probe, `1` otherwise. Exactly one JSON line is written to stdout.

The probe registers exactly one replay-safe tool (`probe_echo`) and submits one instruction:
call the tool once, then answer with `nonce=<value>`. Success requires the final assistant
message to have stop reason `stop` **and** to echo the nonce, plus a successful idempotent
reopen of the same store (same submission id, no extra model call).

## NOT RUN: live endpoint

The probe has **not** been run against a live inference endpoint. Doing so requires a real
credential supplied via the configured environment variable; that was intentionally avoided.
All verified behavior above comes from the real SDK + SQLite + faux provider.
