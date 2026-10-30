/**
 * build-release.mjs — produce clean, versioned macOS beta release artifacts.
 *
 * Outputs (under artifacts/):
 *   - pi-durable-manager-<version>.tgz          npm package (whitelisted `files`)
 *   - pi-durable-manager-source-<version>.zip   source bundle (whitelisted)
 *   - pi-durable-manager-plugin-<version>.zip   portable skills-only Codex plugin
 *   - SHA256SUMS                                 sha256 of every artifact above
 *
 * Safety:
 *   - Never includes .runtime/ .secrets/ node_modules/ .git/ dist-test/ .s/
 *     local-settings.json, QA profiles, personal config, test.out, or any host
 *     path/endpoint/key. Contents are whitelisted (allow-list), not blacklisted.
 *   - Content is scanned by a GENERIC, DYNAMIC privacy scanner that derives its
 *     deny rules from the current environment (see buildContentRules below); it
 *     carries no personal literal and scans every release file, including itself.
 *   - Does not commit, push, or publish anything. Local files only.
 *
 * Usage: node scripts/build-release.mjs
 */

import { execFileSync } from "node:child_process";
import { runtimeLock } from "./runtime-lock.mjs";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import os, { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ARTIFACTS = path.join(ROOT, "artifacts");
const VERSION = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

// ---- Allow-lists (whitelist, not blacklist) --------------------------------
const SOURCE_TOP = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.test.json",
  "LICENSE",
  "README.md",
  "INSTALL.md",
  "CHANGELOG.md",
  "PLAN.md",
  "AGENTS.md",
  ".gitignore",
];
const SOURCE_DIRS = ["src", "tests", "tests-assets", "scripts", "skill", "plugin", "example", "docs", "bin", "vendor"];
// Individual files under dirs we do NOT copy wholesale (avoids scratch dirs).
const SOURCE_FILES = [
  ".github/workflows/quality.yml",
  "tools/sandbox-diagnostic.mjs",
  "tools/verify-scratch.mjs",
  "tools/monitor.mjs",
  "tools/verify-network.mjs",
  "tools/build-pi-ui-vendor.mjs",
];
// Files/dirs never allowed into ANY archive, even if something above matches.
const FORBIDDEN = [
  /[.](orig|rej)$/i,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.runtime(\/|$)/,
  /(^|\/)\.secrets(\/|$)/,
  /(^|\/)dist-test(\/|$)/,
  /(^|\/)\.s(\/|$)/,
  /(^|\/)local-settings\.json$/,
  /(^|\/)config\.local\.json$/,
  /(^|\/)test\.out$/,
  /(^|\/)\.pi-durable-runtime(\/|$)/,
];
// Paths that exist in the working tree but must be skipped (never copied). These are
// personal operational records / incidents — not part of the product.
const SOURCE_EXCLUDE = [/(^|\/)STALL-DIAGNOSIS.*\.md$/i, /(^|\/)[^/]*incident[^/]*\.md$/i];
const PLUGIN_TOP_REQUIRED = ["plugin.json"];
const PLUGIN_SKILLS_DIR = "skills";

function assertSafe(rel) {
  for (const re of FORBIDDEN) {
    if (re.test(rel)) throw new Error(`refusing to package forbidden path: ${rel}`);
  }
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

// ---- Portable privacy/secret scanner --------------------------------------
//
// This scanner is GENERIC and DYNAMIC: it derives the personal host path and
// workspace fragments from the CURRENT environment at build time, so this file
// never contains any personal username or workspace literal itself (there is no
// self-exemption — the scanner is scanned like every other release file). It
// scans the whole staged tree, INCLUDING this script and its own tests.

/** Placeholder account/dir names that are fine to ship (docs/examples). */
const GENERIC_HOME_NAMES = new Set([
  "x",
  "user",
  "username",
  "example",
  "you",
  "yourname",
  "test",
  "someone",
  "me",
  "<user>",
  "home",
  "runner",
  "actions",
]);

/** Path segments too generic to treat as a personal workspace fragment. */
const GENERIC_PATH_SEGMENTS = new Set([
  "",
  "users",
  "home",
  "tmp",
  "private",
  "var",
  "opt",
  "documents",
  "projects",
  "src",
  "code",
  "work",
  "workspace",
  "repos",
  "applications",
  "desktop",
  // Product/brand directory names that are legitimate to reference and are not
  // personal identifiers (e.g. a checkout under a "ChatGPT" folder).
  "chatgpt",
  "codex",
  "openai",
  "github",
  "gitlab",
  "dropbox",
  "icloud",
  "onedrive",
]);

/**
 * Build the dynamic deny rules for THIS machine. Returns a list of
 * `{ re, what, allow? }` where every pattern is derived from runtime values
 * (os, homedir, the current checkout path) — never a hardcoded personal
 * fragment.
 */
function buildContentRules() {
  const rules = [];
  // 1. Any real `/Users/<name>` or `/home/<name>` path, except generic names.
  const accountRoots = ["/Users/", "/home/"];
  for (const root of accountRoots) {
    rules.push({
      // Require the account root to start a path: not preceded by an identifier
      // character, so a slash-separated list of env names ("PATH/HOME/lang") is
      // not misread as a /home/<user> path.
      re: new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(root)}([A-Za-z0-9._-]+)`, "g"),
      what: `personal ${root} path`,
      allow: (m) => {
        const name = (m[1] ?? "").toLowerCase();
        // Short tokens (single letter like /home/u) and documented placeholders
        // are not personal identifiers.
        return name.length < 3 || GENERIC_HOME_NAMES.has(name);
      },
    });
  }
  // 2. The current user's actual account name and home basename, wherever they
  //    appear as a whole token.
  const names = new Set();
  try {
    names.add(os.userInfo().username);
  } catch {
    /* ignore */
  }
  const homeBase = path.basename(homedir());
  if (homeBase) names.add(homeBase);
  for (const name of names) {
    if (!name || name.length < 3) continue; // too short to scan meaningfully
    // Only treat PLAUSIBLE account names as personal. A sandbox HOME basename
    // like ".home" (starts with a dot) is not a person, and matching it would
    // flag unrelated dot-file references.
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(name)) continue;
    if (GENERIC_HOME_NAMES.has(name.toLowerCase())) continue;
    rules.push({
      re: new RegExp(`\\b${escapeRegExp(name)}\\b`),
      what: "personal account name",
    });
  }
  // 3. Non-generic path segments of THIS checkout (workspace/id split
  //    fragments). Derived from ROOT so the build process itself is portable.
  //    The package's OWN name is legitimate everywhere, so exclude it.
  const ownNames = new Set(["pi-durable-manager", "pi-durable"]);
  for (const seg of ROOT.split(path.sep)) {
    const lower = seg.toLowerCase();
    if (seg.length < 4 || GENERIC_PATH_SEGMENTS.has(lower)) continue;
    if (ownNames.has(lower)) continue;
    if (/^[0-9a-f-]{20,}$/i.test(seg)) continue; // random tmp dir
    rules.push({
      re: new RegExp(`\\b${escapeRegExp(seg)}\\b`),
      what: "personal workspace path fragment",
      allow: (m, line) => isFixtureAllowLine(line),
    });
  }
  // 4. Raw-key shapes (generic; fixtures allowed only via the explicit clause).
  rules.push({
    re: new RegExp("\\bsk-" + "[A-Za-z0-9]{20,}"),
    what: "raw-looking API key",
    allow: (m, line) => /sk-abcdef0123456789abcdef/.test(line),
  });
  return rules;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A line is a synthetic-fixture allowance only if it is clearly a fixture: it
 * mentions a fixture/synthetic/example AND a dummy/placeholder token. This is
 * deliberately NARROW — it cannot be used to smuggle a real path or key.
 */
function isFixtureAllowLine(line) {
  return /fixture|synthetic|example/i.test(line) && /sk-[A-Za-z0-9]|dummy|placeholder/.test(line);
}

/** Scan a staged tree. Fails the build if any rule matches a non-allowed line. */
function scanTree(root, base = root) {
  const rules = buildContentRules();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) {
      scanTree(abs, base);
      continue;
    }
    if (!entry.isFile()) continue;
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue; // binary; skip
    }
    for (const rule of rules) {
      if (!rule.re.test(text)) continue;
      const offending = text
        .split("\n")
        .filter((l) => rule.re.test(l))
        .filter((l) => !(rule.allow && rule.allow(rule.re.exec(l) ?? [], l)));
      if (offending.length === 0) continue;
      throw new Error(`refusing to package ${rule.what} found in ${path.relative(root, abs)}`);
    }
  }
}

function copyFileInto(srcRoot, rel, destRoot) {
  assertSafe(rel);
  const src = path.join(srcRoot, rel);
  const dest = path.join(destRoot, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
}

function copyTreeInto(srcRoot, relDir, destRoot) {
  const abs = path.join(srcRoot, relDir);
  if (!existsSync(abs)) return;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(relDir, entry.name);
    if (SOURCE_EXCLUDE.some((re) => re.test(rel))) continue;
    assertSafe(rel);
    if (entry.isDirectory()) copyTreeInto(srcRoot, rel, destRoot);
    else if (entry.isFile()) copyFileInto(srcRoot, rel, destRoot);
  }
}

function stageSourceBundle(destRoot) {
  for (const f of SOURCE_TOP) {
    if (existsSync(path.join(ROOT, f))) copyFileInto(ROOT, f, destRoot);
  }
  for (const d of SOURCE_DIRS) copyTreeInto(ROOT, d, destRoot);
  for (const f of SOURCE_FILES) {
    if (existsSync(path.join(ROOT, f))) copyFileInto(ROOT, f, destRoot);
  }
  // Ship a built dist/ so the bundle is runnable without a build; dist is a
  // build artifact, not a secret.
  copyTreeInto(ROOT, "dist", destRoot);
}

/**
 * Normalize every staged file/dir mtime to a fixed epoch so `zip` produces a
 * byte-identical archive across runs (zip stores per-entry mtimes). We use the
 * conventional 1980-01-01T00:00:00Z DOS epoch that ZIP can represent, which
 * keeps the SHA256SUMS stable and the release reproducible.
 */
const ZIP_EPOCH = 315532800; // 1980-01-01T00:00:00Z in seconds
function normalizeMtimes(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) normalizeMtimes(abs);
    utimesSync(abs, ZIP_EPOCH, ZIP_EPOCH);
  }
}

function zipDir(srcDir, zipPath) {
  // Use the OS zip; exclude nothing extra (we already staged a clean tree).
  // -X strips platform extras; normalized mtimes make the archive reproducible.
  normalizeMtimes(srcDir);
  utimesSync(srcDir, ZIP_EPOCH, ZIP_EPOCH);
  execFileSync("zip", ["-r", "-q", "-X", zipPath, "."], { cwd: srcDir });
}

function stagePlugin(destRoot) {
  const pluginSrc = path.join(ROOT, "plugin");
  for (const req of PLUGIN_TOP_REQUIRED) {
    if (!existsSync(path.join(pluginSrc, req))) throw new Error(`plugin missing ${req}`);
  }
  if (!existsSync(path.join(pluginSrc, PLUGIN_SKILLS_DIR))) {
    throw new Error("plugin missing skills/ directory");
  }
  copyTreeInto(pluginSrc, ".", destRoot);
  // Sanity: no local-settings, no baked personal paths/pointers.
  const manifest = JSON.parse(readFileSync(path.join(destRoot, "plugin.json"), "utf8"));
  if (manifest.version !== VERSION) {
    throw new Error(`plugin.json version ${manifest.version} != package ${VERSION}`);
  }
  if (manifest.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json") {
    throw new Error("plugin.json is not the official portable schema");
  }
  // The plugin ZIP is self-bootstrapping. Embed the independently scanned npm
  // payload only in this staging tree, avoiding recursive npm/plugin archives.
  scanTree(destRoot);
  const serviceDir = path.join(destRoot, "service");
  mkdirSync(serviceDir, { recursive: true });
  const payloadName = `pi-durable-manager-${VERSION}.tgz`;
  const payload = path.join(ARTIFACTS, payloadName);
  cpSync(payload, path.join(serviceDir, payloadName));
  const graph = runtimeLock(JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8")),
    JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")), payloadName, readFileSync(payload));
  writeFileSync(path.join(serviceDir, "runtime-package.json"), JSON.stringify(graph.pkg, null, 2) + "\n");
  writeFileSync(path.join(serviceDir, "runtime-lock.json"), JSON.stringify(graph.lock, null, 2) + "\n");
  writeFileSync(path.join(serviceDir, "runtime.json"), JSON.stringify({
    schemaVersion: 2, version: VERSION, file: payloadName, sha256: sha256File(payload),
    packageFile: "runtime-package.json", packageSha256: sha256File(path.join(serviceDir, "runtime-package.json")),
    lockFile: "runtime-lock.json", lockSha256: sha256File(path.join(serviceDir, "runtime-lock.json")),
  }, null, 2) + "\n");
}

function main() {
  mkdirSync(ARTIFACTS, { recursive: true });
  const compiledVersion = readFileSync(path.join(ROOT, "dist/version.js"), "utf8");
  if (!compiledVersion.includes(`FALLBACK_PACKAGE_VERSION = "${VERSION}"`)) {
    throw new Error("Compiled version is stale. Run npm run release:build.");
  }

  // 1. npm package (uses package.json `files` allow-list).
  execFileSync("npm", ["pack", "--pack-destination", ARTIFACTS], { cwd: ROOT, stdio: "inherit" });
  // Verify the produced tarball contents are clean.
  {
    const tmpPkg = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-pkgscan-")));
    if (!tmpPkg.startsWith(realpathSync(tmpdir()))) throw new Error("temp path escaped tmpdir");
    try {
      const tgz = path.join(ARTIFACTS, `pi-durable-manager-${VERSION}.tgz`);
      execFileSync("tar", ["xzf", tgz, "-C", tmpPkg], { cwd: ROOT });
      scanTree(tmpPkg);
    } finally {
      rmSync(tmpPkg, { recursive: true, force: true });
    }
  }

  // 2. Source bundle (tmp staging, then zip).
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-release-")));
  if (!tmp.startsWith(realpathSync(tmpdir()))) throw new Error("temp path escaped tmpdir");
  try {
    const srcStage = path.join(tmp, "source");
    mkdirSync(srcStage, { recursive: true });
    stageSourceBundle(srcStage);
    scanTree(srcStage);
    const srcZip = path.join(ARTIFACTS, `pi-durable-manager-source-${VERSION}.zip`);
    rmSync(srcZip, { force: true });
    zipDir(srcStage, srcZip);

    const pluginStage = path.join(tmp, "plugin");
    mkdirSync(pluginStage, { recursive: true });
    stagePlugin(pluginStage);
    const pluginZip = path.join(ARTIFACTS, `pi-durable-manager-plugin-${VERSION}.zip`);
    rmSync(pluginZip, { force: true });
    zipDir(pluginStage, pluginZip);

    // The recommended sharing artifact: a complete repository marketplace.
    // Keep the built plugin outside editable plugin/ so npm cannot recursively
    // include the generated runtime payload when this repository is rebuilt.
    const repoStage = path.join(tmp, "repository");
    cpSync(srcStage, repoStage, { recursive: true });
    const pluginDestination = path.join(repoStage, "plugins/pi-durable-manager");
    mkdirSync(path.dirname(pluginDestination), { recursive: true });
    cpSync(pluginStage, pluginDestination, { recursive: true });
    const catalog = path.join(repoStage, ".agents/plugins/marketplace.json");
    mkdirSync(path.dirname(catalog), { recursive: true });
    writeFileSync(catalog, JSON.stringify({
      name: "pi-durable-beta",
      interface: { displayName: "Pi Durable Beta" },
      plugins: [{
        name: "pi-durable-manager",
        source: { source: "local", path: "./plugins/pi-durable-manager" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      }],
    }, null, 2) + "\n");
    scanTree(repoStage);
    const repoZip = path.join(ARTIFACTS, `pi-durable-manager-repository-${VERSION}.zip`);
    rmSync(repoZip, { force: true });
    zipDir(repoStage, repoZip);
    const expanded = path.join(ARTIFACTS, "repository");
    rmSync(expanded, { recursive: true, force: true });
    cpSync(repoStage, expanded, { recursive: true });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // 3. SHA256SUMS for this version's artifacts.
  const names = [
    `pi-durable-manager-${VERSION}.tgz`,
    `pi-durable-manager-source-${VERSION}.zip`,
    `pi-durable-manager-plugin-${VERSION}.zip`,
    `pi-durable-manager-repository-${VERSION}.zip`,
  ];
  const lines = [];
  for (const n of names) {
    const p = path.join(ARTIFACTS, n);
    if (!existsSync(p)) throw new Error(`expected artifact missing: ${n}`);
    lines.push(`${sha256File(p)}  ${n}`);
  }
  const sumsPath = path.join(ARTIFACTS, "SHA256SUMS");
  writeFileSync(sumsPath, lines.join("\n") + "\n");
  process.stdout.write(lines.join("\n") + "\n");

  // Report sizes.
  for (const n of names) {
    const size = statSync(path.join(ARTIFACTS, n)).size;
    process.stdout.write(`${n}: ${size} bytes\n`);
  }
}

main();
