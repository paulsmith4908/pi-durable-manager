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
import { type PiDurableConfig } from "./config.js";
import { CliUsageError } from "./cli-args.js";
/** The beta release this tool reports. Kept in one place for setup/check/docs. */
export declare const BETA_VERSION = "0.7.0-beta.1";
/**
 * The package name used for the portable Codex plugin + skill.
 *
 * This is the plugin `name` in `plugin.json` and the installed skill folder
 * name. It is intentionally NOT the npm package name so the two can evolve
 * independently.
 */
export declare const PLUGIN_NAME = "pi-durable-manager";
/** The scoped skill directory name used inside the plugin. */
export declare const PLUGIN_SKILL_NAME = "pi-durable-manager";
/** The minimum Node major/minor this release supports. */
export declare const NODE_REQUIREMENT = ">=22.19.0";
/** Default private config path, relative to the user's home. */
export declare const DEFAULT_CONFIG_RELATIVE: string;
/** Default private runtime root (state + config + projects) under home. */
export declare const DEFAULT_RUNTIME_RELATIVE: string;
/**
 * Resolve the default private config path for a home directory.
 * No file is read; this is a pure path computation.
 */
export declare function defaultConfigPath(home?: string): string;
/**
 * A noninteractive setup request. Every field maps 1:1 to a CLI flag. There is
 * no place to put a raw credential: `credentialEnv` and `credentialFile` are
 * REFERENCES only.
 */
export interface SetupRequest {
    readonly compatibilityPreset?: "generic" | "legacy-deepseek";
    readonly allowInsecureHttp?: boolean;
    /** Absolute or home-relative private config path to write. */
    readonly configPath: string;
    /** HTTPS (or loopback-HTTP for fixtures) endpoint. */
    readonly endpoint: string;
    /** Model id passed to the provider. */
    readonly model: string;
    /** Either an environment variable name (preferred) or a private key file path. */
    readonly credentialEnv?: string;
    /** Existing private key file path (the file alternative to `credentialEnv`). */
    readonly credentialFile?: string;
    /** Project home root. Created if missing. */
    readonly projectHome?: string;
    /** Private runtime state directory. */
    readonly stateDir?: string;
    /**
     * Additional absolute roots a worker may touch. Defaults to `[projectHome]`.
     * `projectHome` is always included exactly once.
     */
    readonly allowedRoots?: readonly string[];
    /** Explicit development-network opt-in for sandboxed tools. Default `false`. */
    readonly allowNetwork?: boolean;
    /** Replace an existing config file (with a backup), rather than failing. */
    readonly replace?: boolean;
    /** Do not write anything; validate and report what would happen. */
    readonly dryRun?: boolean;
    /** Codex CLI executable for manager wake (default `codex`). */
    readonly codexExecutable?: string;
    /**
     * Optional Codex skill install destination. When set, the skill is installed
     * there. Defaults to `~/.codex/skills/pi-durable`.
     */
    readonly skillDestination?: string;
    /** Install the standalone skill into Codex. Default `false` (opt-in). */
    readonly installSkill?: boolean;
    /** Overwrite an existing owned skill install. */
    readonly replaceSkill?: boolean;
    /**
     * Optional Codex PLUGIN install destination. When set (or when
     * `installTarget: "plugin"`), the plugin is installed there. Defaults to
     * `~/.agents/plugins/pi-durable-manager`.
     */
    readonly pluginDestination?: string;
    /** Optional marketplace catalog path for the plugin install. */
    readonly pluginMarketplace?: string;
    /**
     * What integration to install, chosen explicitly in the guided flow:
     * `"plugin"` (Codex plugin marketplace entry), `"standalone"` (the plain
     * skill folder), or `"none"`. Informational for the report and drives whether
     * a skill install runs. CLI flag `--install-skill` implies `"standalone"`.
     */
    readonly installTarget?: "plugin" | "standalone" | "none";
}
/** The severity of a single setup check. */
export type SetupLevel = "pass" | "warn" | "fail" | "skip";
/** One human-readable preflight check result. */
export interface SetupCheck {
    readonly id: string;
    readonly label: string;
    readonly level: SetupLevel;
    /** Human-readable detail; never contains a credential value. */
    readonly detail: string;
}
/** A structured summary of what setup did (or would do). */
export interface SetupReport {
    readonly version: string;
    readonly ok: boolean;
    readonly dryRun: boolean;
    readonly checks: readonly SetupCheck[];
    readonly configPath: string;
    readonly configWritten: boolean;
    readonly configBackup?: string;
    /** The credential REFERENCE form only (`env:<NAME>` or `file:<path>`). */
    readonly credentialRef?: string;
    readonly projectHome?: string;
    readonly stateDir?: string;
    readonly skillDestination?: string;
    readonly skillInstalled: boolean;
    readonly pluginDestination?: string;
    readonly pluginInstalled: boolean;
    readonly networkEnabled: boolean;
    /** Ordered, human-friendly next actions. */
    readonly nextActions: readonly string[];
}
/** A structured failure that still produces a truthful report. */
export declare class SetupError extends Error {
    readonly code: string;
    readonly report?: SetupReport;
    constructor(code: string, message: string, report?: SetupReport);
}
/** Result of probing one external command. */
export interface CommandProbe {
    readonly found: boolean;
    readonly path?: string;
    readonly version?: string;
    /**
     * For the Codex CLI: did `codex queue --help` respond with a usage that
     * advertises the flags the manager wake path needs (e.g. `--thread-id`,
     * `--prompt`/`--message`)? `undefined` when not probed.
     */
    readonly queueHelpOk?: boolean;
    /** Required queue flags that were NOT found in `queue --help` output. */
    readonly missingQueueFlags?: readonly string[];
}
/** Injected side effects (overridable in tests). */
export interface SetupDeps {
    readonly platform: NodeJS.Platform;
    readonly nodeVersion: string;
    readonly env: NodeJS.ProcessEnv;
    readonly home: string;
    readonly checkPath: (p: string) => boolean;
    /** Probe a command for availability + version. Never executes with secrets. */
    readonly probeCommand: (cmd: string) => Promise<CommandProbe>;
    /** True when `sandbox-exec` is executable on this host. */
    readonly sandboxExecAvailable: boolean;
    /**
     * Optional skill installer. When supplied and a request asks to install the
     * skill, this is invoked and its real boolean result is reported. When
     * absent, setup reports `skillInstalled: false` rather than claiming success.
     */
    readonly installSkill?: (options: InstallSkillOptions) => Promise<boolean>;
    /**
     * Optional PLUGIN installer (Codex marketplace entry + bundled skill). When
     * supplied and the guided flow chose `installTarget: "plugin"`, this runs and
     * its real boolean result is reported. Absent ⇒ plugin install cannot run and
     * setup reports failure rather than claiming success.
     */
    readonly installPlugin?: (options: InstallPluginOptions) => Promise<boolean>;
    /**
     * Optional skill remover, used ONLY to undo a skill install completed earlier
     * in the SAME setup run when a later integration step (the plugin install)
     * fails. Lets `runSetup` keep its atomic guarantee when BOTH integrations are
     * requested. Absent ⇒ the rollback is skipped (and reported truthfully).
     */
    readonly uninstallSkill?: (options: {
        destination: string;
    }) => Promise<void>;
    /** Overrides for the filesystem ops that matter for atomicity tests. */
    readonly fs?: Partial<SetupFs>;
}
/** Filesystem operations used by setup (injectable for failure tests). */
export interface SetupFs {
    readonly existsSync: (p: string) => boolean;
    readonly lstatIsSymlink: (p: string) => boolean;
    readonly readFile: (p: string) => Promise<string>;
    readonly writeFileMode: (p: string, data: string, mode: number) => Promise<void>;
    readonly mkdirMode: (p: string, mode: number) => Promise<void>;
    readonly chmod: (p: string, mode: number) => Promise<void>;
    readonly copyFile: (from: string, to: string) => Promise<void>;
    readonly rename: (from: string, to: string) => Promise<void>;
    readonly rm: (p: string) => Promise<void>;
    readonly statIsDirectory: (p: string) => Promise<boolean>;
    /**
     * STAT-ONLY probe of a credential file: lstat metadata, NO read of contents.
     * Returns `undefined` when the path does not exist (a warning, not a failure:
     * the file may be provisioned privately later). Never returns file bytes.
     */
    readonly statFileInfo: (p: string) => CredentialFileInfo | undefined;
    readonly realpath: (p: string) => string;
}
/** STAT-ONLY metadata about a candidate credential file. Never any bytes. */
export interface CredentialFileInfo {
    /** True for a regular file; false for a directory, socket, device, etc. */
    readonly isRegularFile: boolean;
    /** True when the path itself is a symlink (we validate it, we do not follow). */
    readonly isSymlink: boolean;
    /** Permission bits (e.g. 0o644). */
    readonly mode: number;
}
/** The real filesystem implementation. */
export declare const realSetupFs: SetupFs;
/** Expand a leading `~` to the given home directory. */
export declare function expandHome(p: string, home: string): string;
/**
 * Validate a credential REFERENCE without ever reading a secret value.
 *
 * Exactly one of env/file is accepted. A value that looks like a raw key (e.g.
 * `sk-...`) is rejected with a helpful message rather than accepted, so a user
 * cannot accidentally paste a secret into a CLI argument or transcript.
 */
export declare function validateCredentialReference(input: {
    env?: string;
    file?: string;
    home: string;
}): {
    kind: "env";
    name: string;
} | {
    kind: "file";
    path: string;
};
/** Reject obvious raw-key shapes so a pasted secret is never persisted. */
export declare function looksLikeRawKey(value: string): boolean;
/**
 * Build the exact config object (schema v1) setup would write. Exposed for
 * tests and for `--dry-run`. No file is read or written here; the credential
 * file path is recorded as a reference only and is never opened.
 */
export declare function buildSetupConfig(request: SetupRequest, deps: SetupDeps): PiDurableConfig;
/** Ordered preflight checks; each is truthful about what it can/cannot prove. */
export declare function runPreflight(request: SetupRequest, deps: SetupDeps): Promise<{
    checks: SetupCheck[];
    config: PiDurableConfig | null;
}>;
/**
 * Run the full guided setup.
 *
 * Steps: preflight → create directories → write config atomically (with backup)
 * → optionally install the standalone skill. Any failure stops immediately and,
 * where a write already happened, restores the previous state.
 */
export declare function runSetup(request: SetupRequest, deps: SetupDeps): Promise<SetupReport>;
/** Options for the standalone skill install step. */
export interface InstallSkillOptions {
    readonly destination: string;
    readonly configPath: string;
    readonly replace: boolean;
    readonly deps: SetupDeps;
}
/** Options for the Codex plugin install step. */
export interface InstallPluginOptions {
    readonly destination: string;
    readonly configPath: string;
    readonly marketplace?: string;
    readonly replace: boolean;
    readonly deps: SetupDeps;
}
/**
 * Deep-merge `desired` over `existing`, preserving any `existing` keys that do
 * not appear in `desired`. Used on `--replace` so a regenerated config keeps
 * unknown/forward-compat fields instead of silently dropping them. `desired`
 * always wins for the keys it defines (recursively for plain objects); arrays
 * and scalars from `desired` replace `existing` wholesale.
 */
export declare function mergePreservingUnknown(desired: Record<string, unknown>, existing: Record<string, unknown>): Record<string, unknown>;
/**
 * Idempotence helper: is the on-disk config already exactly what setup would
 * write? Reads ONLY the config file (never a credential value) and compares the
 * non-secret JSON. Returns false when the file is missing or unreadable.
 */
export declare function configMatches(configPath: string, request: SetupRequest, deps: SetupDeps): Promise<boolean>;
export { CliUsageError };
//# sourceMappingURL=setup.d.ts.map