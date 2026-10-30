# Install Pi Durable with Codex

This is the agent-readable installation contract for the macOS beta. Use the
prepared repository archive or its corresponding Git repository/tag. Do not infer
permission to publish, start unrelated workers, change an existing provider, or
inspect credentials from this document.

## 1. Check what is available

- macOS and Git are required. Check that Codex offers the Plugins Directory and
  local execution, and find its actual CLI executable.
- Inspect `codex plugin marketplace add --help` and `codex queue --help`. If either
  capability is missing, explain the missing prerequisite; do not substitute an
  undocumented GUI transport or install a second Codex instance.
- Read `.agents/plugins/marketplace.json`. Its plugin source must resolve to
  `plugins/pi-durable-manager`, which includes `plugin.json`, the two skills, and
  `service/runtime.json` plus the matching `.tgz`.
- If the generated plugin is missing, this is an unprepared development checkout.
  With Node 22.19+ available, run `npm ci` and `npm run release:build`, then use the
  generated `artifacts/repository/` root. Do not install the incomplete `plugin/`
  source folder as if it contained the runtime.

## 2. Register this repository as a plugin source

If working from a downloaded/extracted repository, run:

```sh
codex plugin marketplace add /absolute/path/to/prepared/repository
```

For a repository already hosted on GitHub, use its **actual** URL and the selected
release tag or commit, not a placeholder:

```sh
codex plugin marketplace add https://github.com/paulsmith4908/pi-durable-manager.git --ref v0.7.0-beta.1
```

Registering a source is not installation. In the desktop app, the user opens the
Plugins Directory, chooses **Pi Durable Beta**, and installs **pi-durable-manager**.
Restart the app if the source is not visible. Use the supported UI/tools when
available; otherwise tell the user the exact remaining click. Never claim the
plugin is installed just because the marketplace command succeeded. Do not edit
Codex cache files or overwrite the user's existing marketplace manually.

Local/Git marketplace availability varies by client. Official reference:
https://developers.openai.com/plugins/build/plugins#add-a-marketplace-from-the-cli

## 3. Run guided setup

Select the installed plugin and invoke setup, or ask “Set up Pi Durable.” Follow
its `skills/setup/SKILL.md`. The installed plugin contains a shell bootstrap that
can obtain a private pinned Node runtime; friends need not build the service.

Open the returned loopback setup page beside the chat. The user supplies:

1. Chat Completions API base URL and exact model ID.
2. Server context window and maximum output tokens (do not guess them).
3. API key privately in the page, or the no-auth choice.
4. Whether workers may use development networking.

Keep the server running. Setup installs private runtime dependencies, writes local
configuration, and starts the service. It does not provision the inference server.
Never read password fields, credential files or keys into chat. Existing installs
must be inspected and preserved, not reconfigured with replacement setup.

## 4. Verify, without overstating readiness

- Inspect service health, version and the selected saved profile.
- Run `models.test` through the installed client. It checks streaming tool calls
  and the tool-result round trip. Report failure with no model fallback.
- A passing connection test is not a coding or wake test. Ask the user to select
  Pi in a **new chat** and submit this small acceptance task:

> Use Pi to create a name-deduplication function and tests. Before implementing,
> have the worker ask you whether to preserve order or sort. Decide and answer,
> review the actual files and tests, and finish. Open the live Pi terminal.

Verify the question arrives while Codex is idle, the continuation completes,
actual tests pass, the terminal follows the worker, and finishing retires wakes.
Record assignment/event IDs and outcomes; do not manufacture a pass or restart an
already-handled event. If a real project was already requested, follow its normal
workflow instead of launching a surprise test worker.

## Updates and removal

Prefer a pinned release tag/commit. A marketplace refresh updates the plugin
source; it is not proof the desktop cached plugin or private runtime updated.
Check all versions before claiming an upgrade. This beta has no unattended runtime
migration: finish or safely pause/checkpoint work, preserve state/config/credentials,
and perform a deliberate compatible runtime upgrade. Never replace a running
runtime or reset configuration just to install a new plugin.

For removal, use the desktop plugin uninstall flow and, when desired,
`codex plugin marketplace remove pi-durable-beta`. These do not necessarily stop
the independent Pi service. Stop it through its configured client if requested.
Retain project code and private data unless the user explicitly asks to delete them.
