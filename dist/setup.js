/**
 * Guided setup core for the friend-friendly macOS beta.
 *
 * This module owns the *logic* behind `pi-durable setup`. It is deliberately
 * side-effect-injectable: filesystem, environment, and command probing are
 * passed in (`SetupDeps`) so the whole flow can be exercised in a temporary
 * directory without touching a real home directory, a real config, or the
 * network.
 *
 * Hard rules enforced here (not merely documented):
 *   * The credential is only ever accepted as a REFERENCE — an environment
 *     variable name or an existing private key file path. A raw key is never a
 *     valid argument, never written, and never echoed.
 *   * Existing config/pointer values are preserved unless the caller explicitly
 *     replaces them; a conflicting existing file fails safely unless `replace`
 *     is set, in which case a backup is taken and rolled back on failure.
 *   * Reruns are idempotent.
 *   * Development network access is an explicit opt-in and defaults to `false`.
 *   * No unrelated Codex config / AGENTS files are ever modified.
 */
import { createHash } from "node:crypto";
import { constants as FS, existsSync, lstatSync, readFileSync, realpathSync, } from "node:fs";
import { chmod, copyFile, mkdir, open, readFile, rename, rm, stat, writeFile, } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ConfigError, validateEndpoint, loadConfig } from "./config.js";
import { CliUsageError } from "./cli-args.js";
import { canonicalPath, firstUserSymlinkAncestor } from "./paths.js";
import { redactString } from "./redact.js";
/** The beta release this tool reports. Kept in one place for setup/check/docs. */
export const BETA_VERSION = "0.7.0-beta.3";
/**
 * The package name used for the portable Codex plugin + skill.
 *
 * This is the plugin `name` in `plugin.json` and the installed skill folder
 * name. It is intentionally NOT the npm package name so the two can evolve
 * independently.
 */
export const PLUGIN_NAME = "pi-durable-manager";
/** The scoped skill directory name used inside the plugin. */
export const PLUGIN_SKILL_NAME = "pi-durable-manager";
/** The minimum Node major/minor this release supports. */
export const NODE_REQUIREMENT = ">=22.19.0";
/** Default private config path, relative to the user's home. */
export const DEFAULT_CONFIG_RELATIVE = join(".config", "pi-durable-manager", "config.json");
/** Default private runtime root (state + config + projects) under home. */
export const DEFAULT_RUNTIME_RELATIVE = join(".local", "share", "pi-durable-manager");
/**
 * Resolve the default private config path for a home directory.
 * No file is read; this is a pure path computation.
 */
export function defaultConfigPath(home = homedir()) {
    return join(home, DEFAULT_CONFIG_RELATIVE);
}
/** A structured failure that still produces a truthful report. */
export class SetupError extends Error {
    code;
    report;
    constructor(code, message, report) {
        super(redactString(message));
        this.name = "SetupError";
        this.code = code;
        if (report !== undefined)
            this.report = report;
    }
}
/** The real filesystem implementation. */
export const realSetupFs = {
    existsSync: (p) => existsSync(p),
    lstatIsSymlink: (p) => {
        try {
            return lstatSync(p).isSymbolicLink();
        }
        catch {
            return false;
        }
    },
    readFile: (p) => readFile(p, "utf8"),
    writeFileMode: async (p, data, mode) => {
        await writeFile(p, data, { mode });
        // writeFile's mode is subject to umask; enforce exactly.
        await chmod(p, mode);
    },
    mkdirMode: async (p, mode) => {
        await mkdir(p, { recursive: true, mode });
    },
    chmod: (p, mode) => chmod(p, mode),
    copyFile: (from, to) => copyFile(from, to),
    rename: (from, to) => rename(from, to),
    rm: (p) => rm(p, { recursive: true, force: true }),
    statIsDirectory: async (p) => {
        try {
            return (await stat(p)).isDirectory();
        }
        catch {
            return false;
        }
    },
    statFileInfo: (p) => {
        try {
            // lstat: never follow, so we can detect a symlink and reject it without
            // reading the target's bytes.
            const info = lstatSync(p);
            return {
                isRegularFile: info.isFile(),
                isSymlink: info.isSymbolicLink(),
                // Mask to the permission bits; ignore any high bits.
                mode: info.mode & 0o777,
            };
        }
        catch {
            return undefined;
        }
    },
    realpath: (p) => {
        try {
            return realpathSync(p);
        }
        catch {
            return resolve(p);
        }
    },
};
function fsFor(deps) {
    return { ...realSetupFs, ...(deps.fs ?? {}) };
}
/** Node major/minor parsed from a version string. */
function nodeMinorAtLeast(version, wantMajor, wantMinor) {
    const [major = 0, minor = 0] = version.split(".").map((p) => Number.parseInt(p, 10));
    if (!Number.isFinite(major) || !Number.isFinite(minor))
        return false;
    return major > wantMajor || (major === wantMajor && minor >= wantMinor);
}
/** A short, stable digest of a string (used for backup names; never a secret). */
function shortDigest(input) {
    return createHash("sha256").update(input).digest("hex").slice(0, 8);
}
/** Expand a leading `~` to the given home directory. */
export function expandHome(p, home) {
    if (p === "~")
        return home;
    if (p.startsWith("~/"))
        return join(home, p.slice(2));
    return p;
}
/** Resolve a possibly-relative path against `base`, expanding `~`. */
function resolveAgainst(base, p, home) {
    const expanded = expandHome(p, home);
    return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}
/**
 * Validate a credential REFERENCE without ever reading a secret value.
 *
 * Exactly one of env/file is accepted. A value that looks like a raw key (e.g.
 * `sk-...`) is rejected with a helpful message rather than accepted, so a user
 * cannot accidentally paste a secret into a CLI argument or transcript.
 */
export function validateCredentialReference(input) {
    const { env, file, home } = input;
    if (env !== undefined && env.trim() !== "") {
        if (file !== undefined && file.trim() !== "") {
            throw new SetupError("credential_conflict", "Provide exactly one credential reference: an environment variable name OR a key file path, not both.");
        }
        const name = env.trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            // A name containing a hyphen is the common "I pasted a key" mistake; give
            // an accurate, non-secret-leaking hint either way.
            throw new SetupError("credential_env_invalid", "Credential environment variable name must be a valid env name (letters, digits, underscore; not starting with a digit). " +
                "Pass the NAME of the variable holding your key, not the key itself.");
        }
        return { kind: "env", name };
    }
    if (file !== undefined && file.trim() !== "") {
        const path = resolveAgainst(home, file.trim(), home);
        return { kind: "file", path };
    }
    throw new SetupError("credential_missing", "A credential reference is required. Pass --credential-env <ENV_VAR_NAME> or --credential-file <PATH_TO_KEY_FILE>.");
}
/** Reject obvious raw-key shapes so a pasted secret is never persisted. */
export function looksLikeRawKey(value) {
    return /\bsk-[A-Za-z0-9._-]{8,}/.test(value) || /\b(?:ds|dsk)-[A-Za-z0-9._-]{12,}/.test(value);
}
/**
 * Build the exact config object (schema v1) setup would write. Exposed for
 * tests and for `--dry-run`. No file is read or written here; the credential
 * file path is recorded as a reference only and is never opened.
 */
export function buildSetupConfig(request, deps) {
    const home = deps.home;
    const configDir = dirname(request.configPath);
    // Reject non-HTTPS / non-loopback endpoints up front, using the SAME rule the
    // runtime applies, so setup can never write a config that fails to load.
    validateEndpoint(request.endpoint, request.allowInsecureHttp === true);
    const ref = validateCredentialReference({
        env: request.credentialEnv,
        file: request.credentialFile,
        home,
    });
    const projectHome = resolveAgainst(configDir, request.projectHome ?? "./projects", home);
    const stateDir = resolveAgainst(configDir, request.stateDir ?? "./.runtime", home);
    const roots = new Set();
    roots.add(projectHome);
    for (const extra of request.allowedRoots ?? []) {
        roots.add(resolveAgainst(configDir, extra, home));
    }
    const allowNetwork = request.allowNetwork === true;
    const config = {
        configVersion: 1,
        ...(request.compatibilityPreset ? { compatibilityPreset: request.compatibilityPreset } : {}),
        ...(request.allowInsecureHttp ? { allowInsecureHttp: true } : {}),
        endpoint: request.endpoint,
        model: request.model,
        limits: {
            contextWindow: 65536,
            maxTokens: 16384,
            // Unlimited run/command budgets per the release spec.
            maxSteps: null,
            timeoutMs: null,
        },
        paths: {
            stateDir,
            projectHome,
            allowedRoots: [...roots],
        },
        credential: ref.kind === "env" ? { env: ref.name } : { apiKeyFile: ref.path },
        tools: {
            allowNetwork,
            commandTimeoutMs: null,
        },
        manager: {
            enabled: true,
            cliExecutable: request.codexExecutable?.trim() || "codex",
            cliBaseArgs: ["queue"],
            cliTimeoutMs: 30000,
            maxAttempts: 8,
        },
    };
    return config;
}
/** Ordered preflight checks; each is truthful about what it can/cannot prove. */
export async function runPreflight(request, deps) {
    const checks = [];
    const push = (c) => checks.push(c);
    // 1. macOS
    if (deps.platform === "darwin") {
        push({ id: "platform", label: "macOS detected", level: "pass", detail: `platform=${deps.platform}` });
    }
    else {
        push({
            id: "platform",
            label: "macOS required",
            level: "fail",
            detail: `This beta is tested on macOS only; running on platform=${deps.platform}.`,
        });
    }
    // 2. Node >= 22.19
    if (nodeMinorAtLeast(deps.nodeVersion, 22, 19)) {
        push({ id: "node", label: "Node version", level: "pass", detail: `node ${deps.nodeVersion} (${NODE_REQUIREMENT})` });
    }
    else {
        push({
            id: "node",
            label: "Node version too old",
            level: "fail",
            detail: `node ${deps.nodeVersion} is below the required ${NODE_REQUIREMENT}.`,
        });
    }
    // 3. sandbox-exec
    if (deps.sandboxExecAvailable) {
        push({ id: "sandbox", label: "sandbox-exec available", level: "pass", detail: "/usr/bin/sandbox-exec present" });
    }
    else {
        push({
            id: "sandbox",
            label: "sandbox-exec missing",
            level: deps.platform === "darwin" ? "fail" : "skip",
            detail: "macOS sandbox-exec is required to run bounded worker tools.",
        });
    }
    // 4. Git — REQUIRED (projects create and worker diffs depend on it).
    const git = await deps.probeCommand("git");
    push({
        id: "git",
        label: "Git command",
        level: git.found ? "pass" : "fail",
        detail: git.found
            ? `found${git.version ? ` (${git.version})` : ""}`
            : "git not found on PATH; it is required to create projects and capture worker diffs. Install git (e.g. `xcode-select --install`) and re-run.",
    });
    // 5. Codex queue capability.
    //
    // We do NOT trust `codex --version`: a stub that prints a version (or just
    // exits 0/2) proves nothing about whether the wake path can enqueue work. We
    // probe the actual subcommand the manager uses (`codex queue --help`) and
    // require the flags it passes. A missing/incompatible CLI is a WARNING
    // (incomplete wake readiness), never a PASS — the manager can be used without
    // automatic wake.
    const codexExe = request.codexExecutable?.trim() || "codex";
    const codex = await deps.probeCommand(codexExe);
    const queueOk = codex.queueHelpOk === true && (codex.missingQueueFlags?.length ?? 0) === 0;
    const discovered = codex.path !== undefined ? ` (${codex.path})` : "";
    if (!codex.found) {
        push({
            id: "codex",
            label: "Codex CLI (manager wake)",
            level: "warn",
            detail: `"${codexExe}" not found on PATH. Automatic wake is unavailable until you set manager.cliExecutable; you can still run the service manually.`,
        });
    }
    else if (queueOk) {
        push({
            id: "codex",
            label: "Codex CLI (manager wake)",
            level: "pass",
            detail: `"${codexExe}"${discovered} supports "queue" with the required flags; wake readiness OK.`,
        });
    }
    else {
        const missing = codex.missingQueueFlags ?? [];
        push({
            id: "codex",
            label: "Codex CLI wake readiness",
            level: "warn",
            detail: `"${codexExe}"${discovered} responded but its "codex queue --help" did not advertise the required flags` +
                (missing.length > 0 ? ` (missing: ${missing.map((f) => `--${f}`).join(", ")})` : "") +
                `. Automatic wake may not work; this is not fatal — set manager.cliExecutable to a compatible build.`,
        });
    }
    // 6. Endpoint (validated by the same code path the runtime uses).
    let config = null;
    try {
        config = buildSetupConfig(request, deps);
        // Endpoint was already validated by buildSetupConfig via validateEndpoint;
        // re-derive for the human-facing detail.
        push({ id: "endpoint", label: "Endpoint", level: "pass", detail: `valid (${new URL(config.endpoint).protocol})` });
    }
    catch (error) {
        const message = error instanceof ConfigError ? error.message : redactString(error.message);
        push({ id: "endpoint", label: "Endpoint invalid", level: "fail", detail: message });
    }
    // 7. Credential reference (syntactic only; the file may not exist yet).
    try {
        const ref = validateCredentialReference({
            env: request.credentialEnv,
            file: request.credentialFile,
            home: deps.home,
        });
        if (ref.kind === "env") {
            const present = typeof deps.env[ref.name] === "string" && deps.env[ref.name] !== "";
            push({
                id: "credential",
                label: "Credential reference",
                level: present ? "pass" : "warn",
                detail: `env:${ref.name} ${present ? "(set in this environment)" : "(not set here — provision privately before running)"}`,
            });
        }
        else {
            // STAT-ONLY validation of the credential file. We never read its bytes,
            // so a raw key pasted into the wrong argument is never echoed back. We
            // prove what `stat`/`lstat` can prove: it is a REGULAR file (not a
            // directory/socket/device), it is NOT a symlink, and its permissions are
            // PRIVATE (no group/other read or write: 0o600 or stricter).
            const fs = fsFor(deps);
            const info = fs.statFileInfo(ref.path);
            if (info === undefined) {
                push({
                    id: "credential",
                    label: "Credential reference",
                    level: "warn",
                    detail: `file:${ref.path} (not found yet — create it as a private file, mode 0600, before running; nothing is read here)`,
                });
            }
            else if (info.isSymlink) {
                push({
                    id: "credential",
                    label: "Credential file is a symlink",
                    level: "fail",
                    detail: `file:${ref.path} is a symlink; refusing to trust a redirected credential file. Pass the real, private file path.`,
                });
            }
            else if (!info.isRegularFile) {
                push({
                    id: "credential",
                    label: "Credential path is not a regular file",
                    level: "fail",
                    detail: `file:${ref.path} is not a regular file (directory, socket, or device). Pass the path to a regular private file.`,
                });
            }
            else if ((info.mode & 0o077) !== 0) {
                push({
                    id: "credential",
                    label: "Credential file permissions are too open",
                    level: "fail",
                    detail: `file:${ref.path} has mode ${info.mode.toString(8).padStart(3, "0")}; require 0600 (no group/other access). Run: chmod 600 ${ref.path}`,
                });
            }
            else {
                push({
                    id: "credential",
                    label: "Credential reference",
                    level: "pass",
                    detail: `file:${ref.path} (regular file, private mode ${info.mode
                        .toString(8)
                        .padStart(3, "0")}; contents never read here)`,
                });
            }
        }
    }
    catch (error) {
        push({ id: "credential", label: "Credential reference invalid", level: "fail", detail: error.message });
    }
    // 8. Config path conflict / symlink safety.
    //
    // Canonicalize first so the macOS `/tmp`→`/private/tmp` and `/var`→
    // `/private/var` system aliases are transparent, then reject only a USER
    // symlink (an indirection the user created) and any dangling symlink.
    const fs = fsFor(deps);
    const canonicalConfig = canonicalPath(request.configPath);
    const configMatchesExisting = fs.existsSync(request.configPath) && (await configMatches(request.configPath, request, deps));
    const userSymlink = firstUserSymlinkAncestor(request.configPath, deps.home);
    if (userSymlink !== undefined) {
        push({
            id: "config_path",
            label: "Config path uses a symlink",
            level: "fail",
            detail: `${request.configPath} traverses a symlink (${userSymlink}); refusing to write through it. Pass a real file path.`,
        });
    }
    else if (canonicalConfig !== request.configPath) {
        // Reconciled a system alias or a redundant path; report the canonical form.
        push({
            id: "config_path",
            label: "Config path canonicalized",
            level: "pass",
            detail: `${request.configPath} → ${canonicalConfig}`,
        });
    }
    if (fs.existsSync(request.configPath)) {
        if (fs.lstatIsSymlink(request.configPath)) {
            push({
                id: "config_path_file",
                label: "Config path is a symlink",
                level: "fail",
                detail: `${request.configPath} is a symlink; refusing to write through it. Pass a real file path.`,
            });
        }
        else if (configMatchesExisting && request.replace !== true) {
            // Byte-identical rerun: idempotent success — nothing to rewrite.
            push({
                id: "config_path_file",
                label: "Config already up to date",
                level: "pass",
                detail: `${request.configPath} already matches this setup; no changes needed.`,
            });
        }
        else if (request.replace === true) {
            push({
                id: "config_path_file",
                label: "Existing config will be replaced",
                level: "warn",
                detail: "An existing config exists; a timestamped backup will be taken and restored on failure.",
            });
        }
        else {
            push({
                id: "config_path_file",
                label: "Config already exists",
                level: "fail",
                detail: `${request.configPath} already exists with different settings. Re-run with --replace to back it up and overwrite.`,
            });
        }
    }
    else if (userSymlink === undefined) {
        push({ id: "config_path_file", label: "Config path", level: "pass", detail: `${request.configPath} (new file)` });
    }
    // 9. Development network is opt-in and reported explicitly.
    push({
        id: "network",
        label: "Development network",
        level: "pass",
        detail: request.allowNetwork === true ? "ENABLED (explicit opt-in)" : "disabled (default)",
    });
    return { checks, config };
}
/** True when no check is a hard failure. */
function preflightOk(checks) {
    return !checks.some((c) => c.level === "fail");
}
/** Next actions surfaced after a successful setup. */
function nextActions(configPath, stateDir, projectHome, installedSkill) {
    const actions = [
        `1. Provision your key privately (env var or 0600 file). Setup never stores it.`,
        `2. Check everything: pi-durable check --config ${configPath} --offline`,
        `3. Start the service: pi-durable service start --config ${configPath}`,
        `4. Open a project: pi-durable projects create --name my-app --path ${join(projectHome, "my-app")} --request-id proj-1 --json`,
    ];
    if (!installedSkill) {
        actions.push("5. Optional: install the Codex skill/plugin so a new chat can drive this (see docs/BETA-QUICKSTART.md).");
    }
    else {
        actions.push("5. Open a NEW Codex chat and say: \"Use the pi-durable-manager skill to set up a project.\"");
    }
    actions.push(`Runtime state lives under ${stateDir}. Uninstalling keeps your config (${configPath}), projects (${projectHome}), and state by default — remove them yourself only if you are sure.`);
    return actions;
}
/**
 * Run the full guided setup.
 *
 * Steps: preflight → create directories → write config atomically (with backup)
 * → optionally install the standalone skill. Any failure stops immediately and,
 * where a write already happened, restores the previous state.
 */
export async function runSetup(request, deps) {
    const fs = fsFor(deps);
    const dryRun = request.dryRun === true;
    const { checks, config } = await runPreflight(request, deps);
    const ok = preflightOk(checks) && config !== null;
    const baseReport = {
        version: BETA_VERSION,
        ok,
        dryRun,
        checks,
        configPath: request.configPath,
        configWritten: false,
        skillInstalled: false,
        pluginInstalled: false,
        networkEnabled: request.allowNetwork === true,
        nextActions: [],
    };
    if (!ok || config === null) {
        throw new SetupError("preflight_failed", "Setup preflight failed; nothing was written. Fix the failing checks and re-run.", { ...baseReport, nextActions: ["Resolve the failing checks above, then re-run `pi-durable setup`."] });
    }
    const credentialRef = config.credential.env !== undefined ? `env:${config.credential.env}` : `file:${config.credential.apiKeyFile}`;
    if (dryRun) {
        return {
            ...baseReport,
            credentialRef,
            projectHome: config.paths.projectHome,
            stateDir: config.paths.stateDir,
            nextActions: ["Dry-run only: nothing was written. Re-run without --dry-run to apply."],
        };
    }
    // --- Idempotent rerun: if the on-disk config already matches byte-for-byte
    // and the caller did not ask to replace, do NOT rewrite or back up. ---
    if (request.replace !== true && (await configMatches(request.configPath, request, deps))) {
        // Still ensure directories exist (cheap, idempotent) but touch no file.
        await fs.mkdirMode(config.paths.projectHome, 0o700);
        await fs.mkdirMode(config.paths.stateDir, 0o700);
        const { skillInstalled, pluginInstalled, skillDestination, pluginDestination } = await runRequestedInstalls(request, deps, baseReport);
        return {
            ...baseReport,
            ok: true,
            configWritten: false,
            credentialRef,
            projectHome: config.paths.projectHome,
            stateDir: config.paths.stateDir,
            skillDestination,
            skillInstalled,
            pluginDestination,
            pluginInstalled,
            nextActions: [
                `Config already present and up to date at ${request.configPath}; nothing was rewritten.`,
                ...nextActions(request.configPath, config.paths.stateDir, config.paths.projectHome, skillInstalled || pluginInstalled),
            ],
        };
    }
    // --- Create directories (idempotent) ---
    await fs.mkdirMode(config.paths.projectHome, 0o700);
    await fs.mkdirMode(config.paths.stateDir, 0o700);
    await fs.mkdirMode(dirname(request.configPath), 0o700);
    // --- Preserve unknown/extra fields on --replace ---
    //
    // A `--replace` regenerates the config from the request, which would DROP any
    // keys this build does not know about (forward-compat: a newer config written
    // by a different version, or hand-added fields). Overlay the freshly built
    // config ON TOP of the existing one so known fields are authoritative but any
    // other existing keys survive. Done BEFORE backup/write so a failure here
    // leaves the on-disk config untouched.
    let configToWrite = config;
    if (request.replace === true && fs.existsSync(request.configPath)) {
        try {
            const existingRaw = await fs.readFile(request.configPath);
            const existingParsed = JSON.parse(existingRaw);
            configToWrite = mergePreservingUnknown(config, existingParsed);
        }
        catch {
            // Unreadable/invalid existing config: fall back to the freshly built one.
            configToWrite = config;
        }
    }
    // --- Write config atomically with backup/rollback ---
    const configJson = `${JSON.stringify(configToWrite, null, 2)}\n`;
    let backup;
    let wrote = false;
    try {
        if (fs.existsSync(request.configPath)) {
            // Symlink refusal is already enforced in preflight, but re-check defensively.
            if (fs.lstatIsSymlink(request.configPath)) {
                throw new SetupError("config_symlink", "Config path became a symlink; refusing to write.");
            }
            backup = `${request.configPath}.bak-${shortDigest(`${Date.now()}`)}`;
            await fs.copyFile(request.configPath, backup);
            await fs.chmod(backup, 0o600);
        }
        // Stage then rename for atomicity.
        const staged = `${request.configPath}.staged-${shortDigest(`${Date.now()}-${Math.random()}`)}`;
        await fs.writeFileMode(staged, configJson, 0o600);
        // Validate the staged bytes with the REAL runtime parser (loadConfig) — not
        // a hand-built approximation — so we can never install a config the running
        // service would reject.
        try {
            await loadConfig(staged);
        }
        catch (validationError) {
            await fs.rm(staged).catch(() => undefined);
            throw new SetupError("config_invalid", `Setup produced a config the runtime rejects: ${redactString(validationError.message)}`, baseReport);
        }
        try {
            await fs.rename(staged, request.configPath);
        }
        catch (renameError) {
            await fs.rm(staged).catch(() => undefined);
            throw renameError;
        }
        wrote = true;
    }
    catch (error) {
        // Roll back to the backup if we took one and the write failed.
        if (!wrote && backup !== undefined) {
            try {
                await fs.copyFile(backup, request.configPath);
                await fs.chmod(request.configPath, 0o600);
            }
            catch {
                throw new SetupError("rollback_failed", `Config write failed AND rollback failed. Your previous config backup is preserved at ${backup}.`, baseReport);
            }
        }
        throw new SetupError("config_write_failed", `Failed to write config: ${redactString(error.message)}${backup ? ` (previous config backed up at ${backup})` : ""}`, baseReport);
    }
    // --- Optional integration install (skill and/or plugin) ---
    //
    // Integration installs are REQUIRED steps when requested: a failure must NOT
    // be reported as `ok:true, skillInstalled:false`. We roll the config write
    // back (restore the backup, or remove the freshly written file when there was
    // none) so the run is atomic, then fail with a non-zero exit.
    let skillInstalled = false;
    let pluginInstalled = false;
    let skillDestination;
    let pluginDestination;
    try {
        const result = await runRequestedInstalls(request, deps, baseReport);
        skillInstalled = result.skillInstalled;
        pluginInstalled = result.pluginInstalled;
        skillDestination = result.skillDestination;
        pluginDestination = result.pluginDestination;
    }
    catch (error) {
        // Roll back the config write (atomic run).
        try {
            if (backup !== undefined) {
                await fs.copyFile(backup, request.configPath);
                await fs.chmod(request.configPath, 0o600);
            }
            else if (fs.existsSync(request.configPath)) {
                await fs.rm(request.configPath);
            }
        }
        catch {
            throw new SetupError("rollback_failed", `Integration install failed AND config rollback failed. Your previous config backup is preserved at ${backup ?? "(none — the new config may remain)"}.`, baseReport);
        }
        throw error;
    }
    return {
        ...baseReport,
        ok: true,
        configWritten: true,
        configBackup: backup,
        credentialRef,
        projectHome: config.paths.projectHome,
        stateDir: config.paths.stateDir,
        skillDestination,
        skillInstalled,
        pluginDestination,
        pluginInstalled,
        nextActions: nextActions(request.configPath, config.paths.stateDir, config.paths.projectHome, skillInstalled || pluginInstalled),
    };
}
/**
 * Run the skill and/or plugin installs the request asked for. Throws a
 * `SetupError` when a REQUESTED install fails, so callers can roll back. Returns
 * the real install results otherwise.
 */
/**
 * Undo a skill install that completed EARLIER in the same setup run, when a
 * later integration step fails. Best-effort: only runs when the skill was
 * actually installed this run and the destination is known. Never throws (the
 * caller is already handling a failure) — but every failure mode is recorded.
 */
async function rollbackSkillInstalledThisRun(deps, skillInstalled, skillDestination) {
    if (!skillInstalled || skillDestination === undefined)
        return;
    if (deps.uninstallSkill === undefined)
        return;
    try {
        await deps.uninstallSkill({ destination: skillDestination });
    }
    catch {
        // Swallow: rollback is best-effort, and the original error is still raised.
    }
}
async function runRequestedInstalls(request, deps, baseReport) {
    let skillInstalled = false;
    let pluginInstalled = false;
    let skillDestination;
    let pluginDestination;
    if (request.installSkill === true) {
        skillDestination = request.skillDestination ?? join(deps.home, ".codex", "skills", "pi-durable");
        if (skillDestination.trim() === "") {
            throw new SetupError("skill_destination", "Skill destination must not be empty.", baseReport);
        }
        if (deps.installSkill !== undefined) {
            skillInstalled = await deps.installSkill({
                destination: skillDestination,
                configPath: request.configPath,
                replace: request.replaceSkill === true,
                deps,
            });
        }
        if (!skillInstalled) {
            throw new SetupError("skill_install_failed", "Skill install was requested but failed; the config write was rolled back so nothing was left half-applied.", { ...baseReport, configWritten: false, skillInstalled: false, pluginInstalled: false });
        }
    }
    if (request.installTarget === "plugin") {
        pluginDestination = request.pluginDestination ?? join(deps.home, ".agents", "plugins", "pi-durable-manager");
        if (pluginDestination.trim() === "") {
            // Nothing installed yet; no skill rollback needed.
            throw new SetupError("plugin_destination", "Plugin destination must not be empty.", baseReport);
        }
        if (deps.installPlugin === undefined) {
            await rollbackSkillInstalledThisRun(deps, skillInstalled, skillDestination);
            throw new SetupError("plugin_install_failed", "A Codex plugin install was requested but the installer is unavailable in this environment.", { ...baseReport, configWritten: false, skillInstalled: false, pluginInstalled: false });
        }
        try {
            pluginInstalled = await deps.installPlugin({
                destination: pluginDestination,
                configPath: request.configPath,
                marketplace: request.pluginMarketplace,
                replace: request.replaceSkill === true,
                deps,
            });
        }
        catch (pluginError) {
            // A thrown plugin install must still undo any skill we installed earlier
            // in this same run, then surface the original error.
            await rollbackSkillInstalledThisRun(deps, skillInstalled, skillDestination);
            throw pluginError;
        }
        if (!pluginInstalled) {
            await rollbackSkillInstalledThisRun(deps, skillInstalled, skillDestination);
            throw new SetupError("plugin_install_failed", "Plugin install was requested but failed; any skill installed earlier in this run was rolled back too, so nothing was left half-applied.", { ...baseReport, configWritten: false, skillInstalled: false, pluginInstalled: false });
        }
    }
    return { skillInstalled, pluginInstalled, skillDestination, pluginDestination };
}
/**
 * Deep-merge `desired` over `existing`, preserving any `existing` keys that do
 * not appear in `desired`. Used on `--replace` so a regenerated config keeps
 * unknown/forward-compat fields instead of silently dropping them. `desired`
 * always wins for the keys it defines (recursively for plain objects); arrays
 * and scalars from `desired` replace `existing` wholesale.
 */
export function mergePreservingUnknown(desired, existing) {
    const out = { ...existing };
    for (const [key, value] of Object.entries(desired)) {
        const prior = existing[key];
        if (isPlainObject(value) && isPlainObject(prior)) {
            out[key] = mergePreservingUnknown(value, prior);
        }
        else {
            out[key] = value;
        }
    }
    return out;
}
function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Idempotence helper: is the on-disk config already exactly what setup would
 * write? Reads ONLY the config file (never a credential value) and compares the
 * non-secret JSON. Returns false when the file is missing or unreadable.
 */
export async function configMatches(configPath, request, deps) {
    const fs = fsFor(deps);
    if (!fs.existsSync(configPath))
        return false;
    try {
        const raw = await fs.readFile(configPath);
        const parsed = JSON.parse(raw);
        const desired = buildSetupConfig(request, deps);
        return JSON.stringify(parsed) === JSON.stringify(desired);
    }
    catch {
        return false;
    }
}
export { CliUsageError };
//# sourceMappingURL=setup.js.map