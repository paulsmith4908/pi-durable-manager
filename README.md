# Pi Durable for Codex

Let Codex manage a project while Pi workers write the code using a model you choose.
Codex stays in your desktop chat; Pi runs locally, keeps durable task history, asks
questions when it needs a decision, and wakes that chat when work needs review.

**macOS beta · 0.7.0-beta.3 · explicit opt-in · no MCP server required**

## Install with Codex

Give Codex this prompt:

> Install Pi Durable from https://github.com/paulsmith4908/pi-durable-manager
> at tag v0.7.0-beta.3. Read INSTALL.md and follow the supported plugin setup.
> Preserve my existing settings. Open guided setup so I can enter my model
> endpoint privately, then check the connection.

[INSTALL.md](INSTALL.md) gives Codex the exact installation steps. The prepared
repository includes a Codex marketplace and the complete plugin runtime. You may
need to restart the app and install Pi from the Plugins Directory once. Installing
Pi does not start a coding worker.

In guided setup, provide your OpenAI-compatible Chat Completions base URL, model
ID, context/output limits, and an API key if your server requires one. Enter keys
only in the local setup page, never in chat. You can use localhost, a LAN server
with explicit HTTP opt-in, or an HTTPS provider. The model must support streaming
and tool calls; API compatibility alone does not guarantee useful coding behavior.

[Simple first-use instructions](docs/BETA-QUICKSTART.md) ·
[Provider and model settings](docs/MODEL-SETTINGS.md)

## Use it

Open a new Codex chat, select **Pi Durable** with the **+** picker, and describe
your project. Or explicitly say “Use Pi for this.” For example:

> Use Pi to build a small name-deduplication library with tests. Have the worker
> ask whether to preserve order or sort before it writes code. You decide, answer,
> review the files and tests, and finish. Open the Pi terminal beside this chat.

Codex owns the roadmap, decisions and acceptance. Pi owns the delegated code.
Unrelated requests stay with Codex unless you select Pi again. “Do this yourself”
keeps a task with Codex.

The browser beside the chat has three views:

- **Progress:** roadmap, current step, recent plain-English work.
- **Terminal:** the actual Pi renderer observing the same worker, with recorded
  history. Opening it does not start a separate agent.
- **Settings:** operator-controlled worker permissions, saved providers/models, the default for new projects, and project
  overrides. Existing sessions keep their model; no silent fallback.

## Instruction ownership

Pi never creates `AGENTS.md` in your projects. Existing repository instructions remain yours.
Repository `AGENTS.md`, when you choose to provide it, guides Codex. The plugin skill guides Codex as Pi manager.
Pi worker restrictions are injected into the worker agent by the service; they
are not global Codex rules. Codex can carry out explicitly requested Git/release
actions after reviewing and settling worker work. See
[the instruction boundary guide](docs/INSTRUCTION-BOUNDARIES.md).

## How it works

The plugin bundles skills, a scriptable client, and a checksum-verified service
package. On first use, setup installs a private runtime under
`~/Library/Application Support/Pi Durable`. A local service owns assignments,
checkpoints, working briefs, validation receipts and the event outbox. Inference
goes to your selected model endpoint; worker commands run on your Mac in the
configured sandbox.

Questions and review events wake the existing Codex chat through a compatible
native `codex queue` command. Adaptive checks run in service code, not an LLM
polling loop. Codex verifies actual files and test evidence before accepting work.
The viewer can disconnect without stopping workers.

## Requirements and limits

- macOS, Git, and a Codex desktop installation with the plugin picker, local
  execution and compatible `codex queue` support. Setup checks prerequisites.
- Node 22.19+; setup can download a pinned private Node if needed. Initial runtime
  installation needs internet access for dependencies. No sudo or global npm install.
- A running model server. Pi does not download, launch or configure llama.cpp,
  oMLX, Modal or other inference servers for you.
- Modal and a generic HTTP fixture have been exercised. Actual llama.cpp/oMLX
  deployments, a second physical Mac, and all model templates remain unverified.
- No login item is installed. After a Mac restart, reconnect from Codex to start
  the service. Sleeping/offline Macs cannot deliver timely wakes.
- Delivery is at-least-once, with persisted decisions and event deduplication;
  already-started chat turns cannot be recalled. Interrupted commands may require
  review and are never blindly replayed.
- Provider token counts are recorded where available. Billing cost is not computed.
- Worker networking is a separate explicit setup choice. Model access does not
  automatically grant workers package-download or other network access.
- Model profiles and endpoint addresses are immutable; add a replacement to change
  them. Added providers support key rotation and disabling in Settings once their
  workers are settled. The original externally configured connection is preserved.
  Updating a plugin does not silently replace an existing private runtime.
- This is a local-executor beta, not a general ChatGPT web/mobile plugin. Nothing
  is committed, pushed, published or deployed automatically.

## Develop and prepare a release

```sh
npm ci
npm test
npm run release:build
npm run release:verify
```

`artifacts/pi-durable-manager-repository-0.7.0-beta.3.zip` is the clean repository
snapshot to share or publish later. It contains source, documentation, a repo
marketplace, and `plugins/pi-durable-manager/` with its bundled runtime. Use this
prepared snapshot, not the working directory with local scratch/history.

`plugin/` is the editable plugin source; `plugins/pi-durable-manager/` is generated
for distribution. The build scans allowed files for private paths/keys and never
copies local projects, service state, credentials or dependencies. `SHA256SUMS`
identifies the artifacts. Checksums detect corruption; they are not publisher signatures.

See [release and sharing instructions](docs/SHARING.md), [changes](CHANGELOG.md),
and the technical guides in `docs/` for recovery, validation and operating details.

MIT licensed. Includes upstream Pi packages under their own licenses.

Worker permissions can be changed in Settings for the default or a project. They cover
file editing, shell commands, development networking, configured browser checks and
additional excluded paths. Changes require affected work to be stopped first. The
private operator link grants settings access; a plain observer link is read-only.
See [permission controls](plugin/skills/pi-durable-manager/references/permissions.md).
