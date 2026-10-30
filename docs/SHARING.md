# Prepare and share the macOS beta

## Recommended route

Use one Git repository containing the prepared source and a self-contained plugin
under `plugins/pi-durable-manager`. Its `.agents/plugins/marketplace.json` points
at that folder. Friends give Codex the repository link and follow [INSTALL.md](../INSTALL.md).
A public marketplace submission is not required for this local/Git distribution.

Official supported source registration:
https://developers.openai.com/plugins/build/plugins#add-a-marketplace-from-the-cli

Do not publish this working checkout wholesale. It may contain scratch data,
local service records and untracked files. The release builder makes an allowlisted,
scanned repository snapshot. No step below commits, pushes or publishes.

## Prepare a candidate

```sh
npm ci
npm test
npm run release:build
npm run release:verify
```

The builder checks version alignment and produces:

| Artifact | Purpose |
| --- | --- |
| `pi-durable-manager-repository-VERSION.zip` | Recommended complete repository snapshot for friends or a new GitHub repository |
| `pi-durable-manager-plugin-VERSION.zip` | Plugin with skills and checksum-verified runtime payload |
| `pi-durable-manager-source-VERSION.zip` | Source/development archive; not the complete installable marketplace |
| `pi-durable-manager-VERSION.tgz` | Runtime package for advanced CLI installs |
| `SHA256SUMS` | Integrity hashes for the four archives |
| `repository/` | Expanded contents of the repository ZIP, ready for review |

The generated repo includes both editable `plugin/` source and the complete
`plugins/pi-durable-manager/` distribution. Only the latter is in the marketplace.
The build does not recursively embed the generated distribution in the runtime.
Generated artifacts are replaced locally on the next build.

`release:verify` verifies archive hashes, marketplace paths, version alignment,
embedded payload and production-lock integrity, deterministic `npm ci --ignore-scripts`, and a real clean runtime installation plus guided
configuration/start/stop on this Mac. It uses its own temporary data directory and
an explicitly unavailable local model endpoint; it creates no worker and makes no
inference calls. Its result therefore proves packaging and setup, not model coding
quality or fresh-chat wake delivery. It writes `artifacts/release-verification.json`.
The normal tests cover model transport with fixtures; real-provider and GUI tests
must be recorded separately.

## After review, publish deliberately

1. Review the prepared snapshot and test report. Confirm licensing and the exact
   release version. Check that generated `plugins/` is included, not just `plugin/`.
2. With explicit authorization, publish that snapshot to the chosen GitHub repository.
   Do not add personal projects, runtime state, keys, local-settings, or raw logs.
3. Tag the accepted version and attach the plugin/repository ZIPs and SHA256SUMS to
   that release. Checksums detect corruption; they are not signing/notarization.
4. Send the repository URL and the short prompt in the quickstart. Prefer a pinned
   tag or commit for repeatable installs.
5. Do a first-use run on a second physical Mac before widening distribution. A
   temporary clean directory on the development Mac is not a second-machine test.

Public plugin-directory review, workspace admin policies, and supported installation
surfaces are separate from preparing a Git marketplace. Do not claim approval or
universal availability from a successful local install.

## Updating an existing friend installation

Plugin refresh and service upgrade are separate. The private runtime intentionally
preserves existing configuration. Supported inspect/upgrade/repair/rollback commands require an idle stopped service and a compatible database schema. There is no unattended migration. Do not overwrite a running runtime or reset the model endpoint. Follow the
version and safe-handoff guidance in [INSTALL.md](../INSTALL.md#updates-and-removal).

## Advanced runtime-only installation

If you specifically want CLI/skill installation rather than the complete plugin,
prefer the packaged installer, which verifies the payload and honors the production lock, then
use its `bin/pi-durable.js setup` and packaged installers. This is not the friend
quickstart. An editable source skill without the service payload cannot bootstrap
by itself. The [model settings guide](MODEL-SETTINGS.md) describes providers,
profiles and the supported selection precedence.
