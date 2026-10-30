# Install Pi Durable with Codex

This is the agent-readable installation contract for the macOS beta. Use the
prepared repository archive or its corresponding Git repository/tag. Do not infer
permission to publish, start unrelated workers, change an existing provider, or
inspect credentials from this document.

Use the current guide from the repository's default branch while installing the
pinned release below. Documentation can improve after a release; published tags
and runtime payloads stay unchanged.

## 1. Check what is available

An explicit request to install from this repository authorizes Codex to perform
the registration, plugin installation, and runtime setup steps below. Do not send
the user to a terminal or plugin directory when the current client can perform
the step. A bare repository link is not, by itself, permission to install software.

- macOS and Git are required. Check that Codex offers the Plugins Directory and
  local execution, and find its actual CLI executable.
- Inspect `codex plugin marketplace add --help` and `codex queue --help`. If either
  capability is missing, explain the missing prerequisite; do not substitute an
  undocumented GUI transport or install a second Codex instance.
- Also inspect `codex plugin add --help` and `codex plugin list --help`. Current
  clients can install the plugin directly; older clients may require the desktop
  installation fallback below. Use the compatible CLI bundled with the current
  desktop app when `codex` is absent from PATH; do not change shell profiles.
- Read `.agents/plugins/marketplace.json`. Its plugin source must resolve to
  `plugins/pi-durable-manager`, which includes `plugin.json`, the two skills, and
  `service/runtime.json` plus the matching `.tgz`.
- If the generated plugin is missing, this is an unprepared development checkout.
  With Node 22.19+ available, run `npm ci` and `npm run release:build`, then use the
  generated `artifacts/repository/` root. Do not install the incomplete `plugin/`
  source folder as if it contained the runtime.

## 2. Register and install the plugin for the user

First inspect `codex plugin marketplace list --json` and, when supported,
`codex plugin list --marketplace pi-durable-beta --json`. Reuse a matching source
and installed version. If an existing source points elsewhere or a different
version is installed, report the mismatch and follow the upgrade procedure;
do not replace it or reset a configured service as part of first-use setup.

If working from a downloaded/extracted repository, run:

```sh
codex plugin marketplace add /absolute/path/to/prepared/repository
```

For a repository already hosted on GitHub, use its **actual** URL and the selected
release tag or commit, not a placeholder:

```sh
codex plugin marketplace add https://github.com/paulsmith4908/pi-durable-manager.git --ref v0.7.0-beta.3
```

After registration, use the supported installation command when available:

```sh
codex plugin add pi-durable-manager@pi-durable-beta --json
codex plugin list --marketplace pi-durable-beta --json
```

Check the install receipt and list result: the exact plugin must be installed,
enabled, and at the requested version. Registration alone is not installation.
Use the `installedPath` returned by installation to read its setup skill. For an
existing install, use the client-provided skill/plugin location; do not guess a
cache path or edit cache files. Preserve existing Codex settings and marketplaces.

**Older-client fallback only:** if `plugin add` is unsupported, use the supported
desktop plugin tools/UI if available. Otherwise tell the user the remaining click:
open the Plugins Directory, choose **Pi Durable Beta**, and install
**pi-durable-manager**. Do not substitute an undocumented API or bypass an install
policy or approval. A new chat or app restart may still be needed for the picker
to discover the plugin; report this only if it is actually needed.

Local/Git marketplace availability varies by client. Official reference:
https://developers.openai.com/plugins/build/plugins#add-a-marketplace-from-the-cli

## 3. Run guided setup

Continue the same installation request by reading the installed plugin's
`skills/setup/SKILL.md` and starting guided setup. The user does not need to invoke
the plugin a second time to finish installation. The installed plugin contains a
shell bootstrap that can obtain a private pinned Node runtime; friends need not
build the service.

Open the returned loopback setup page beside the chat. The user supplies:

1. Chat Completions API base URL and exact model ID.
2. Server context window and maximum output tokens (do not guess them).
3. API key privately in the page, or the no-auth choice.
4. Worker permissions: editing, shell commands, development networking, and configured host validation. Review the choices before saving; excluded paths can be added later in Settings.

Codex performs the installation commands; the user provides model details and
chooses permissions. Host approval dialogs still apply. Do not promise a completely
unattended install, infer broader worker access, or enter secrets on the user's behalf.

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
Check all versions before claiming an upgrade. Updates are explicit:

1. Resolve any active/paused work and in-doubt command receipts. Stop the idle service
   through the existing installed client. A paused worker holding a lease is not idle.
2. From the **new installed plugin**, run:
   `node skills/pi-durable-manager/scripts/maintenance.mjs inspect`.
3. Run the same script with `upgrade`. It installs the checksum-verified runtime using
   the included dependency lock, backs up private state and switches the installation
   pointer. It refuses live services, writer leases and incompatible database schemas.
4. Reconnect with the plugin, then verify the service version, selected model and
   effective permissions before delegating.

Use `repair` for a missing runtime or provably abandoned install lock. Use `rollback`
with the service stopped to select the recorded previous runtime **only when its
schema is compatible**. Rollback preserves current project/state data; it never
restores an old database over newer work. `--data-home /absolute/path` selects a
nondefault plugin installation. Legacy development layouts require a deliberate
operator migration and are not silently moved by these commands.

See [maintenance details](docs/MAINTENANCE.md). These operations preserve model settings
and credentials and require no credential contents in chat. Existing repository
AGENTS.md files remain untouched; review or remove any old generated guidance only
when the repository owner requests it.

For removal, use the desktop plugin uninstall flow and, when desired,
`codex plugin marketplace remove pi-durable-beta`. These do not necessarily stop
the independent Pi service. Stop it through its configured client if requested.
Retain project code and private data unless the user explicitly asks to delete them.
