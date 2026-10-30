/**
 * `pi-durable setup` — the friendly guided entry point.
 *
 * Two modes:
 *   * Noninteractive: every value supplied by a flag; ideal for scripts and for
 *     the tests. `--json` yields one envelope on stdout.
 *   * Interactive: when stdin is a TTY and required values are missing, small
 *     prompts collect them. Prompts NEVER ask for a raw key — only for a
 *     reference (env var name or existing private file path).
 *
 * Truthfulness rules: a failure exits non-zero with `ok:false`; a dry-run never
 * writes; `--json` stdout is exactly one JSON object.
 */

import { accessSync, constants as FS, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { CliUsageError, parseArgs } from "./cli-args.js";
import { errorEnvelope, okEnvelope, serializeEnvelope, type CliEnvelope } from "./cli-status.js";
import { redactString } from "./redact.js";
import {
  BETA_VERSION,
  DEFAULT_CONFIG_RELATIVE,
  type CommandProbe,
  type InstallPluginOptions,
  type InstallSkillOptions,
  type SetupCheck,
  type SetupDeps,
  type SetupReport,
  type SetupRequest,
  SetupError,
  defaultConfigPath,
  runSetup,
  validateCredentialReference,
} from "./setup.js";

/** The `setup` help text (also used by `setup --help --json`). */
export const SETUP_HELP = [
  "pi-durable setup — guided setup for the macOS beta",
  "",
  "Usage:",
  "  pi-durable setup [options]",
  "",
  "Options:",
  "  --config PATH             Private config file to write (default ~/.config/pi-durable-manager/config.json)",
  "  --compatibility-preset NAME  generic (new servers) or legacy-deepseek",
  "  --allow-insecure-http     Explicitly allow unencrypted remote/LAN HTTP",
  "  --endpoint URL            HTTPS endpoint (HTTP allowed only for loopback fixtures)",
  "  --model ID                Model id passed to the provider",
  "  --credential-env NAME     Env var NAME holding your key (a reference — never the key)",
  "  --credential-file PATH    Existing private key file (the alternative to --credential-env)",
  "  --project-home DIR        Project home root (created if missing; default ./projects beside the config)",
  "  --state-dir DIR           Private runtime state dir (default ./.runtime beside the config)",
  "  --allow-root DIR          Extra absolute root a worker may touch (repeatable or comma-separated)",
  "  --allow-network           Opt IN to development network for sandboxed tools (default: disabled)",
  "  --codex-executable PATH|NAME  Codex CLI for manager wake (default: codex)",
  "  --install-target KIND     Integration to install: plugin | standalone | none (guided flow)",
  "  --install-skill           Also install the standalone Codex skill (implies --install-target standalone)",
  "  --skill-destination DIR   Skill destination (default ~/.codex/skills/pi-durable)",
  "  --plugin-destination DIR  Plugin destination (default ~/.agents/plugins/pi-durable-manager)",
  "  --plugin-marketplace PATH Marketplace catalog to update (default beside the plugin destination)",
  "  --replace                 Replace an existing config (with a backup; rolled back on failure)",
  "  --replace-skill           Overwrite an existing owned skill install",
  "  --dry-run                 Validate and report; write nothing",
  "  --json                    Emit one JSON envelope on stdout",
  "  --help                    Show this help",
  "",
  "Your credential is never stored, echoed, or read by setup — only referenced.",
  "",
].join("\n");

/** Everything the CLI needs from the process, injectable for tests. */
export interface SetupCliDeps {
  readonly deps: SetupDeps;
  /** Prompt the user for a line of input. Only used in interactive mode. */
  readonly prompt?: (question: string) => Promise<string>;
  /** True when stdin is an interactive TTY. */
  readonly isTty: boolean;
  /**
   * Force the guided interactive flow even when not attached to a TTY (used by
   * tests and by `PI_DURABLE_SETUP_INTERACTIVE=1`). Callers must supply a
   * `prompt` that terminates — a closed stdin resolves the pending question with
   * an empty line so the flow fails fast rather than hanging.
   */
  readonly forceInteractive?: boolean;
  /** Sink for human-readable progress (defaults to a no-op so --json stays clean). */
  readonly log?: (line: string) => void;
}

/**
 * Flags the manager wake path passes to `codex queue` and therefore requires.
 *
 * The real supported `codex queue` interface is:
 *   `codex queue [OPTIONS] --thread <THREAD> --message <TEXT>`
 * (verified against the hosted Codex CLI `queue --help`). We require exactly the
 * flags the dispatcher passes — `--thread` and `--message` — never the old,
 * unsupported `--thread-id`/`--prompt` spellings.
 */
export const REQUIRED_QUEUE_FLAGS = ["thread", "message"] as const;

/**
 * Probe a command for availability and (for Codex) real wake readiness.
 *
 * `codex --version` is deliberately NOT trusted: any stub can print a version
 * (or exit 0/2) without being able to enqueue work. For Codex we run the actual
 * subcommand the manager uses, `codex queue --help`, and look for the required
 * flags. Probing never passes a credential and never runs the model.
 */
export async function defaultProbeCommand(cmd: string): Promise<CommandProbe> {
  const base = cmd.split(/[\\/]/).pop() ?? cmd;
  if (base === "codex") {
    return probeCodexQueue(cmd);
  }
  try {
    const res = spawnSync(cmd, ["--version"], { encoding: "utf8", timeout: 5000, env: minimalProbeEnv() });
    if (res.error) {
      // ENOENT etc. — try `which`-style presence via PATH lookup only.
      const found = findOnPath(cmd);
      return { found: found !== undefined, path: found };
    }
    const version = (res.stdout || res.stderr || "").trim().split("\n")[0] ?? "";
    return { found: true, version: version.length > 0 ? version : undefined, path: findOnPath(cmd) };
  } catch {
    const found = findOnPath(cmd);
    return { found: found !== undefined, path: found };
  }
}

/**
 * A minimal, secret-free environment for probing external executables. We pass
 * only PATH/HOME/lang basics — never the parent's full env (which may hold API
 * keys) — so a probed binary can never exfiltrate or read credentials.
 */
export function minimalProbeEnv(): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "SystemRoot", "ComSpec", "PATHEXT"];
  const out: NodeJS.ProcessEnv = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Discover the Codex app/CLI executable the manager should record. Prefers an
 * explicit `--codex-executable`, then `codex` on PATH, then well-known app-bundle
 * locations. Returns the absolute resolved path when found (so the config never
 * bakes a personal, machine-specific path unless it actually exists there).
 */
export function discoverAppExecutable(preferred?: string): string | undefined {
  if (preferred !== undefined && preferred.trim() !== "") {
    const p = preferred.trim();
    const onPath = findOnPath(p);
    if (onPath !== undefined) return onPath;
    if (p.includes("/")) {
      try {
        accessSync(p, FS.X_OK);
        return p;
      } catch {
        /* fall through */
      }
    }
    return undefined;
  }
  const onPath = findOnPath("codex");
  if (onPath !== undefined) return onPath;
  return discoverBundledCodex();
}

/**
 * Discover a Codex CLI bundled inside an installed app (e.g. the ChatGPT desktop
 * app ships one under `Contents/Resources/codex-cli/`). Generic: scans the
 * standard macOS application directories for `*.app` bundles and looks for a
 * bundled `codex` executable under the well-known relative locations. Returns
 * the first executable found, or `undefined`. No personal user path is baked in
 * — only app-global compatibility locations relative to standard app dirs.
 */
export function discoverBundledCodex(): string | undefined {
  const appDirs = ["/Applications", join(homedir(), "Applications")];
  // Bundled-CLI relative locations, most specific first. Kept generic — a
  // bundle may nest the CLI a level or two down under Resources.
  const relCandidates = [
    ["Contents", "Resources", "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex"],
    ["Contents", "Resources", "codex-cli", "bin", "codex"],
    ["Contents", "MacOS", "codex"],
    ["Contents", "Resources", "codex"],
    ["Contents", "Resources", "app", "codex"],
  ];
  for (const dir of appDirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".app")) continue;
      for (const rel of relCandidates) {
        const candidate = join(dir, entry, ...rel);
        try {
          accessSync(candidate, FS.X_OK);
          return candidate;
        } catch {
          /* keep searching */
        }
      }
    }
  }
  // Also cover the non-bundled standalone installs.
  for (const candidate of ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]) {
    try {
      accessSync(candidate, FS.X_OK);
      return candidate;
    } catch {
      /* keep searching */
    }
  }
  return undefined;
}

/**
 * Probe Codex by running `queue --help` (the subcommand the manager uses) and
 * checking for the required flags. A non-zero exit, empty output, or missing
 * flag is reported truthfully so setup can warn instead of falsely passing.
 */
export function probeCodexQueue(cmd: string): CommandProbe {
  const first = spawnSync(cmd, ["queue", "--help"], { encoding: "utf8", timeout: 5000, env: minimalProbeEnv() });
  if (first.error || first.status === null) {
    return { found: false };
  }
  const helpText = `${first.stdout ?? ""}${first.stderr ?? ""}`;
  // If `queue --help` is unsupported, try a bare `queue` (some CLIs print usage
  // on a missing subcommand). Never treat a version string as evidence.
  let text = helpText;
  if (text.trim().length === 0) {
    const second = spawnSync(cmd, ["queue"], { encoding: "utf8", timeout: 5000, env: minimalProbeEnv() });
    text = `${second.stdout ?? ""}${second.stderr ?? ""}`;
  }
  const missing = REQUIRED_QUEUE_FLAGS.filter(
    (flag) => !new RegExp(`--${flag}(?![\\w-])`).test(text),
  );
  return {
    found: true,
    path: findOnPath(cmd) ?? discoverAppExecutable(cmd),
    queueHelpOk: first.status === 0 && missing.length === 0,
    missingQueueFlags: missing,
  };
}

/** Locate an executable on PATH (no execution). */
function findOnPath(cmd: string): string | undefined {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(":")) {
    if (dir.length === 0) continue;
    const candidate = join(dir, cmd);
    try {
      accessSync(candidate, FS.X_OK);
      return candidate;
    } catch {
      /* keep searching */
    }
  }
  return undefined;
}

/** Build the default production {@link SetupDeps}. */
export function defaultSetupDeps(env: NodeJS.ProcessEnv = process.env): SetupDeps {
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  return {
    platform: process.platform,
    nodeVersion: process.versions.node,
    env,
    home,
    checkPath: (p) => existsSync(p),
    probeCommand: defaultProbeCommand,
    sandboxExecAvailable: process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec"),
    installSkill: (options) => installSkillViaScript(options),
    installPlugin: (options) => installPluginViaScript(options),
  };
}

/** Known value-taking `setup` flags, used for strict unknown-flag rejection. */
const SETUP_VALUE_FLAGS = new Set<string>([
  "config",
  "endpoint",
  "compatibility-preset",
  "model",
  "credential-env",
  "credential-file",
  "project-home",
  "state-dir",
  "allow-root",
  "codex-executable",
  "skill-destination",
  "plugin-destination",
  "plugin-marketplace",
  "install-target",
]);

/** Parse flags into a {@link SetupRequest}. Missing interactive values are left undefined. */
export function requestFromFlags(
  flags: ReadonlyMap<string, string>,
  home: string,
  booleanValues: ReadonlyMap<string, boolean> = new Map<string, boolean>(),
): Partial<SetupRequest> {
  const truthy = (name: string) => flagIsTrue(booleanValues, name);
  const configPath = flags.get("config") ?? defaultConfigPath(home);
  const allowedRoots: string[] = [];
  // parseArgs keeps only the LAST value for a repeated flag; support comma lists.
  const rootsRaw = flags.get("allow-root");
  if (rootsRaw !== undefined && rootsRaw.length > 0) {
    for (const r of rootsRaw.split(",")) if (r.trim() !== "") allowedRoots.push(r.trim());
  }
  const installTargetRaw = flags.get("install-target");
  let installTarget: SetupRequest["installTarget"];
  if (installTargetRaw === "plugin" || installTargetRaw === "standalone" || installTargetRaw === "none") {
    installTarget = installTargetRaw;
  } else if (installTargetRaw !== undefined) {
    throw new CliUsageError(
      "bad_install_target",
      `--install-target must be one of: plugin, standalone, none (got "${installTargetRaw}").`,
      2,
    );
  }
  return {
    configPath,
    compatibilityPreset: flags.get("compatibility-preset") as "generic" | "legacy-deepseek" | undefined,
    allowInsecureHttp: truthy("allow-insecure-http") ? true : undefined,
    endpoint: flags.get("endpoint"),
    model: flags.get("model"),
    credentialEnv: flags.get("credential-env"),
    credentialFile: flags.get("credential-file"),
    projectHome: flags.get("project-home"),
    stateDir: flags.get("state-dir"),
    allowedRoots: allowedRoots.length > 0 ? allowedRoots : undefined,
    allowNetwork: truthy("allow-network") ? true : undefined,
    replace: truthy("replace") ? true : undefined,
    dryRun: truthy("dry-run") ? true : undefined,
    codexExecutable: flags.get("codex-executable"),
    skillDestination: flags.get("skill-destination"),
    pluginDestination: flags.get("plugin-destination"),
    pluginMarketplace: flags.get("plugin-marketplace"),
    installSkill: truthy("install-skill") ? true : undefined,
    replaceSkill: truthy("replace-skill") ? true : undefined,
    installTarget: installTarget ?? (truthy("install-skill") ? "standalone" : undefined),
  };
}

/** True when a boolean flag is present and not explicitly `false`. */
function flagIsTrue(booleanValues: ReadonlyMap<string, boolean>, name: string): boolean {
  return booleanValues.get(name) === true;
}

/** Fill any missing required values interactively (never asks for a raw key). */
export async function collectInteractive(
  partial: Partial<SetupRequest>,
  cli: SetupCliDeps,
): Promise<SetupRequest> {
  const prompt = cli.prompt;
  if (prompt === undefined) {
    throw new CliUsageError(
      "missing_values",
      "Missing required values and no interactive prompt is available. Provide --endpoint, --model and a credential reference.",
    );
  }
  const home = cli.deps.home;
  let endpoint = partial.endpoint;
  let model = partial.model;
  let credentialEnv = partial.credentialEnv;
  let credentialFile = partial.credentialFile;
  let projectHome = partial.projectHome;
  let allowNetwork = partial.allowNetwork;
  let installSkill = partial.installSkill;
  let installTarget = partial.installTarget;

  if (endpoint === undefined || endpoint.trim() === "") {
    endpoint = (await prompt("Endpoint URL (https://...): ")).trim();
  }
  if (model === undefined || model.trim() === "") {
    model = (await prompt("Model id: ")).trim();
  }
  if ((credentialEnv === undefined || credentialEnv === "") && (credentialFile === undefined || credentialFile === "")) {
    const answer = (
      await prompt(
        "Credential REFERENCE — press Enter to use an env var name, or type a path to an existing key file: ",
      )
    ).trim();
    // A blank answer or anything that is not clearly a filesystem path is
    // treated as an env var NAME; the validator rejects raw keys either way.
    if (answer === "" || !answer.includes("/")) {
      credentialEnv = (await prompt("Environment variable NAME holding your key: ")).trim();
    } else {
      credentialFile = answer;
    }
  }
  if (projectHome === undefined || projectHome.trim() === "") {
    const answer = (await prompt(`Project directory [${join(home, "projects")}]: `)).trim();
    projectHome = answer === "" ? undefined : answer;
  }
  if (allowNetwork === undefined) {
    const answer = (await prompt("Allow sandboxed tools development network access? [y/N]: ")).trim().toLowerCase();
    allowNetwork = answer === "y" || answer === "yes";
  }
  if (installSkill === undefined && installTarget === undefined) {
    const answer = (
      await prompt("Install integration — [p]lugin / [s]tandalone skill / [n]one (default n): ")
    ).trim().toLowerCase();
    if (answer === "p" || answer === "plugin") {
      // Plugin bundles its own skill copy, so do NOT ALSO install the standalone
      // skill — that would create conflicting duplicates.
      installTarget = "plugin";
      installSkill = false;
    } else if (answer === "s" || answer === "standalone" || answer === "skill") {
      installTarget = "standalone";
      installSkill = true;
    } else {
      installTarget = "none";
      installSkill = false;
    }
  }

  return {
    ...partial,
    configPath: partial.configPath ?? defaultConfigPath(home),
    compatibilityPreset: partial.compatibilityPreset,
    allowInsecureHttp: partial.allowInsecureHttp,
    endpoint: endpoint ?? "",
    model: model ?? "",
    credentialEnv,
    credentialFile,
    projectHome,
    allowNetwork,
    installSkill,
    installTarget,
  } as SetupRequest;
}

/** Render the report for humans (no secrets; references only). */
function renderHuman(report: SetupReport): string {
  const lines: string[] = [];
  lines.push(`pi-durable setup ${report.version}${report.dryRun ? " (dry-run)" : ""}`);
  lines.push("");
  for (const c of report.checks) {
    const mark = c.level === "pass" ? "PASS" : c.level === "warn" ? "WARN" : c.level === "fail" ? "FAIL" : "SKIP";
    lines.push(`  [${mark}] ${c.label} — ${c.detail}`);
  }
  lines.push("");
  if (report.ok) {
    lines.push("Summary:");
    lines.push(`  Config:      ${report.configPath}${report.configWritten ? "" : " (unchanged)"}`);
    if (report.configBackup) lines.push(`  Backup:      ${report.configBackup}`);
    if (report.credentialRef) lines.push(`  Credential:  ${report.credentialRef} (value never stored)`);
    if (report.projectHome) lines.push(`  Projects:    ${report.projectHome}`);
    if (report.stateDir) lines.push(`  State:       ${report.stateDir}`);
    lines.push(`  Network:     ${report.checks.find((c) => c.id === "network")?.detail ?? "disabled (default)"}`);
    if (report.skillInstalled && report.skillDestination) {
      lines.push(`  Skill:       installed → ${report.skillDestination}`);
    }
    if (report.pluginInstalled && report.pluginDestination) {
      lines.push(`  Plugin:      installed → ${report.pluginDestination}`);
    }
    if (!report.skillInstalled && !report.pluginInstalled) {
      lines.push(`  Integration: none`);
    }
    lines.push("");
    lines.push("Next actions:");
    for (const a of report.nextActions) lines.push(`  - ${a}`);
  } else {
    lines.push("Setup did not complete. Nothing was written.");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Run the `setup` command. Returns the process exit code.
 *
 * `argv` is the argv AFTER the `setup` token. `cli.deps` supplies all side
 * effects so tests can run entirely inside a temp dir.
 */
export async function runSetupCommand(
  argv: readonly string[],
  cli: SetupCliDeps,
): Promise<number> {
  const json = argv.includes("--json");
  const emit = (envelope: CliEnvelope) => {
    if (json) process.stdout.write(serializeEnvelope(envelope));
  };
  // Strip the leading `setup` command token if present so the parser sees only
  // flags (setup takes no positionals of its own).
  const flagArgv = argv[0] === "setup" ? argv.slice(1) : argv;
  try {
    const parsed = parseArgs(flagArgv, {
      strict: true,
      valueFlags: SETUP_VALUE_FLAGS,
      booleanFlags: new Set([
        "json",
        "help",
        "dry-run",
        "replace",
        "replace-skill",
        "install-skill",
        "allow-network",
  "allow-insecure-http",
      ]),
      // setup takes no positional arguments.
      maxCommandTokens: 0,
      maxPositionals: 0,
    });
    if (parsed.booleans.has("help")) {
      if (json) emit(okEnvelope({ help: SETUP_HELP }));
      else process.stdout.write(SETUP_HELP);
      return 0;
    }
    const partial = requestFromFlags(parsed.flags, cli.deps.home, parsed.booleanValues);

    let request: SetupRequest;
    const complete =
      partial.endpoint !== undefined &&
      partial.endpoint.trim() !== "" &&
      partial.model !== undefined &&
      partial.model.trim() !== "" &&
      ((partial.credentialEnv !== undefined && partial.credentialEnv !== "") ||
        (partial.credentialFile !== undefined && partial.credentialFile !== ""));
    if (complete) {
      request = partial as SetupRequest;
    } else if (cli.isTty || cli.forceInteractive === true) {
      request = await collectInteractive(partial, cli);
    } else {
      throw new CliUsageError(
        "missing_values",
        "Missing required values. Provide --endpoint, --model and a credential reference (--credential-env NAME or --credential-file PATH). Run `pi-durable setup --help`.",
      );
    }

    // Reject a pasted raw key EARLY, before any filesystem work, with a clear hint.
    if (request.credentialEnv !== undefined && request.credentialEnv.includes("sk-")) {
      throw new CliUsageError(
        "credential_raw_key",
        "It looks like you passed a raw API key. Pass the NAME of an environment variable instead; setup never stores secrets.",
      );
    }

    const report = await runSetup(request, cli.deps);
    if (cli.log !== undefined && !json) cli.log(renderHuman(report));
    if (json) emit({ ok: report.ok, result: report });
    else process.stdout.write(renderHuman(report));
    return report.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof CliUsageError) {
      if (json) emit(errorEnvelope(error.code, error.message));
      else process.stderr.write(`error: ${error.message}\n`);
      return error.exitCode;
    }
    if (error instanceof SetupError) {
      if (json) {
        emit({ ok: false, error: { code: error.code, message: error.message }, result: error.report });
      } else {
        process.stderr.write(`error: ${error.message}\n`);
        if (error.report !== undefined) process.stderr.write(renderHuman(error.report));
      }
      return 1;
    }
    const message = redactString((error as Error).message);
    if (json) emit(errorEnvelope("setup_failed", message));
    else process.stderr.write(`error: ${message}\n`);
    return 1;
  }
}

/**
 * Resolve the absolute path to this package's CLI entry point (`bin/pi-durable.js`)
 * from a directory inside the package (`dist/`). Used to record a real `bin`
 * pointer so an installed skill can launch the CLI without relying on PATH.
 */
export function resolvePackageCliPath(fromDir: string): string {
  return resolve(fromDir, "..", "bin", "pi-durable.js");
}

/**
 * Invoke `scripts/install-skill.mjs` for the standalone skill install. Located
 * relative to the compiled CLI (`dist/cli-setup.js` → `../scripts`). Returns the
 * real success boolean; a missing installer returns `false` (never a fake pass).
 */
function installSkillViaScript(options: InstallSkillOptions): Promise<boolean> {
  const here = dirname(fileURLToPath(import.meta.url));
  const installer = join(here, "..", "scripts", "install-skill.mjs");
  if (!existsSync(installer)) {
    process.stderr.write(`warning: packaged skill installer not found at ${installer}; skill not installed.\n`);
    return Promise.resolve(false);
  }
  const bin = resolvePackageCliPath(here);
  const args = [
    installer,
    "--destination", options.destination,
    "--config", options.configPath,
    "--bin", bin,
  ];
  if (options.replace) args.push("--replace");
  args.push("--json");
  const res = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (res.status !== 0) {
    process.stderr.write(`warning: skill install exited ${res.status ?? "unknown"}. ${(res.stderr || "").trim()}\n`);
    return Promise.resolve(false);
  }
  return Promise.resolve(true);
}

/**
 * Invoke `scripts/install-plugin.mjs` for the Codex plugin install. Records the
 * real package CLI `bin` pointer and the resolved config so the bundled skill
 * launcher works from any cwd. Returns the real success boolean; a missing
 * installer returns `false` (never a fake pass).
 */
function installPluginViaScript(options: InstallPluginOptions): Promise<boolean> {
  const here = dirname(fileURLToPath(import.meta.url));
  const installer = join(here, "..", "scripts", "install-plugin.mjs");
  if (!existsSync(installer)) {
    process.stderr.write(`warning: packaged plugin installer not found at ${installer}; plugin not installed.\n`);
    return Promise.resolve(false);
  }
  const bin = resolvePackageCliPath(here);
  const args = [
    installer,
    "--destination", options.destination,
    "--config", options.configPath,
    "--bin", bin,
  ];
  if (options.marketplace) args.push("--marketplace", options.marketplace);
  if (options.replace) args.push("--replace");
  args.push("--json");
  const res = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (res.status !== 0) {
    process.stderr.write(`warning: plugin install exited ${res.status ?? "unknown"}. ${(res.stderr || "").trim()}\n`);
    return Promise.resolve(false);
  }
  return Promise.resolve(true);
}

/**
 * Collect the JSON summary of the environment without writing anything. Used by
 * the `--json` dry-run path in integration tests to assert no writes occurred.
 */
export function setupSummaryLine(report: SetupReport): string {
  return JSON.stringify({ version: report.version, ok: report.ok, dryRun: report.dryRun });
}

export { BETA_VERSION, DEFAULT_CONFIG_RELATIVE, validateCredentialReference };
export type { SetupCheck, SetupDeps, SetupReport };
