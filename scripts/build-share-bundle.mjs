#!/usr/bin/env node
/**
 * build-share-bundle.mjs — assemble the "friend share" ZIP for a beta release.
 *
 * The share bundle is what you hand to a friend who has never seen this repo.
 * It contains everything needed to install and drive pi-durable-manager WITHOUT
 * cloning the source tree:
 *
 *   pi-durable-manager-friend-share-<version>/
 *     BOOTSTRAP.md                     <- start here (plain instructions)
 *     quickstart.md                    <- the full guided quickstart
 *     pi-durable-manager-<version>.tgz <- npm package (install with npm)
 *     pi-durable-manager-plugin-<version>.zip  <- portable skills-only Codex plugin
 *     SHA256SUMS                       <- hashes of the two payloads above
 *
 * Safety:
 *   - Reads the artifacts produced by scripts/build-release.mjs; refuses to run
 *     if any required payload is missing (run the release build first).
 *   - Non-destructive: never deletes or overwrites other artifacts. The share
 *     zip for THIS version is regenerated in place; older share zips are left
 *     untouched.
 *   - Writes only under artifacts/. Does not commit, push, or publish.
 *   - Staging dir is created with mkdtemp under os.tmpdir() and verified to
 *     start with the OS temp dir before anything is written into it.
 *
 * Usage: node scripts/build-share-bundle.mjs
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ARTIFACTS = path.join(ROOT, "artifacts");
const VERSION = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

const TGZ = `pi-durable-manager-${VERSION}.tgz`;
const PLUGIN_ZIP = `pi-durable-manager-plugin-${VERSION}.zip`;
const SHARE_ZIP = `pi-durable-manager-friend-share-${VERSION}.zip`;

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Minimal, explicit bootstrap the friend runs first. */
function bootstrapMd() {
  return `# pi-durable-manager ${VERSION} — friend share

Unzip this bundle, open the extracted folder in Codex, and send:

> Install the Pi Durable plugin from this folder's local marketplace and set it up.
> Run the necessary setup commands for me and open its private setup page.

This folder already contains a local marketplace and the expanded plugin. Codex can register
this folder using \`codex plugin marketplace add /absolute/path/to/this/folder\`, then install
\`pi-durable-manager@pi-durable-beta\` with \`codex plugin add\`. If the CLI is not on PATH,
Codex can use its compatible bundled executable. It verifies installation and continues into
guided setup in the same chat. Older clients may require an install click; a reload/new chat
may be needed for the picker. Codex opens a private local page that installs and starts the
service for you. Normal approval prompts still apply.

1. Enter your OpenAI-compatible Chat Completions API base URL.
2. Discover/select the model, or enter its exact ID if discovery is unavailable.
3. Enter an API key privately in that page if required; never paste it in chat.
4. Enter the model's configured context and output-token limits.
5. Review editing, shell, networking and host-validation permissions, then click **Install and start Pi Durable**.

You do not need to clone this repository or manually install the service. The plugin can
install a private Node runtime if needed; Git/Apple developer tools and compatible Codex
queue support remain prerequisites. Dependencies require internet access. No sudo, hooks,
global package installation, publication, or automatic delegation is used.

Local service health is verified during setup. A live model coding check is a separate step;
ask Codex to run one after reviewing the endpoint's capabilities. The existing provider
is preserved. The plugin does not provision a model server. Another physical Mac is still an untested beta limitation.

The included npm package is an optional CLI-first installation for operators. See
\`quickstart.md\` for that route, installation details, and troubleshooting.

## Integrity

Verify the payload hashes against \`SHA256SUMS\`:

\`\`\`sh
shasum -a 256 -c SHA256SUMS
\`\`\`
`;
}

function main() {
  const tgzPath = path.join(ARTIFACTS, TGZ);
  const pluginPath = path.join(ARTIFACTS, PLUGIN_ZIP);
  for (const [label, p] of [
    [TGZ, tgzPath],
    [PLUGIN_ZIP, pluginPath],
  ]) {
    if (!existsSync(p)) {
      throw new Error(`missing artifact ${label}; run \`node scripts/build-release.mjs\` first`);
    }
  }

  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-share-")));
  if (!tmp.startsWith(realpathSync(tmpdir()))) throw new Error("temp path escaped tmpdir");
  try {
    const stage = path.join(tmp, `pi-durable-manager-friend-share-${VERSION}`);
    mkdirSync(stage, { recursive: true });

    cpSync(tgzPath, path.join(stage, TGZ));
    cpSync(pluginPath, path.join(stage, PLUGIN_ZIP));

    // Ready-made local marketplace: the friend can ask Codex to register this
    // extracted folder directly, without hand-editing any JSON or installing npm.
    const pluginDir = path.join(stage, "plugins", "pi-durable-manager");
    mkdirSync(pluginDir, { recursive: true });
    execFileSync("unzip", ["-q", pluginPath, "-d", pluginDir]);
    const catalogDir = path.join(stage, ".agents", "plugins");
    mkdirSync(catalogDir, { recursive: true });
    writeFileSync(path.join(catalogDir, "marketplace.json"), JSON.stringify({
      name: "pi-durable-beta",
      interface: { displayName: "Pi Durable Beta" },
      plugins: [{ name: "pi-durable-manager", source: { source: "local", path: "./plugins/pi-durable-manager" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }],
    }, null, 2) + "\n");

    const quickstart = path.join(ROOT, "docs", "BETA-QUICKSTART.md");
    if (!existsSync(quickstart)) throw new Error("missing docs/BETA-QUICKSTART.md");
    cpSync(quickstart, path.join(stage, "quickstart.md"));

    writeFileSync(path.join(stage, "BOOTSTRAP.md"), bootstrapMd());

    // SHA256SUMS for the two payloads (quickstart/BOOTSTRAP are prose).
    const sums = [`${sha256File(path.join(stage, TGZ))}  ${TGZ}`, `${sha256File(path.join(stage, PLUGIN_ZIP))}  ${PLUGIN_ZIP}`];
    writeFileSync(path.join(stage, "SHA256SUMS"), sums.join("\n") + "\n");

    const shareZip = path.join(ARTIFACTS, SHARE_ZIP);
    rmSync(shareZip, { force: true }); // fresh archive; never update stale entries
    execFileSync("zip", ["-r", "-q", shareZip, path.basename(stage)], { cwd: tmp, stdio: "inherit" });
    if (!existsSync(shareZip)) throw new Error("share zip was not produced");

    console.log(`share bundle: ${SHARE_ZIP}`);
    console.log(`${sha256File(shareZip)}  ${SHARE_ZIP}`);
    console.log(`size: ${statSync(shareZip).size} bytes`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main();
