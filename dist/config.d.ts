/**
 * Config schema (portable, version 1).
 *
 * Everything is explicit. There is no ambient discovery and no fallback
 * provider/model: an operator must name the endpoint and model. Relative file
 * paths are resolved against the directory containing the config file, so a
 * config directory can be relocated as a unit.
 */
export interface PiDurableConfig {
    /** Schema version. Only `1` is currently accepted. */
    configVersion: 1;
    compatibilityPreset?: "legacy-deepseek" | "generic";
    reasoning?: boolean;
    allowInsecureHttp?: boolean;
    /** OpenAI-compatible endpoint. Must be HTTPS, or HTTP on loopback for tests. */
    endpoint: string;
    /** Model id passed to the provider. Never chosen ad hoc at runtime. */
    model: string;
    /**
     * Token/step/output limits. Fixed model metadata; the runtime must not
     * invent values.
     */
    limits: ConfigLimits;
    /** Private runtime directories. These are state, not source. */
    paths: ConfigPaths;
    /** How the credential is located. Exactly one reference form is accepted. */
    credential: CredentialRef;
    /**
     * Tool-execution policy. `allowNetwork` is an explicit opt-in for tools that
     * reach the network; it defaults to `false` (no network). This is a sandbox
     * policy flag and is distinct from provider inference, which always uses the
     * configured Modal provider.
     */
    tools?: ToolsConfig;
    /**
     * Event-driven manager WAKE policy. Optional; when omitted, NO manager
     * wake is ever dispatched (the outbox still records events durably, but
     * nothing is handed to the Codex CLI). Binding a project to a manager thread
     * is a SEPARATE, explicit runtime action (`manager.bind`).
     */
    manager?: ManagerConfig;
    /**
     * Optional OpenAI-completions compatibility overrides. Validated against the
     * known field set before being forwarded to the provider.
     */
    compat?: CompatOverrides;
}
/**
 * Manager WAKE policy.
 *
 * `cliExecutable` is the Codex CLI binary: an absolute path, or a bare name
 * resolved on PATH (e.g. `codex`). It is executed with an ARGV array — never a
 * shell — under a minimal trusted-host environment allowlist. No model API key
 * or provider secret is ever passed to it.
 */
export interface ManagerConfig {
    /** Codex CLI executable: an absolute path, or a bare name on PATH. */
    cliExecutable?: string;
    /** Optional base argv before the fixed `queue` subcommand (default `["queue"]`). */
    cliBaseArgs?: readonly string[];
    /** Per-attempt CLI timeout (ms). Defaults to 30000. */
    cliTimeoutMs?: number;
    /** Max dispatch attempts before an event is parked as `failed`. Default 8. */
    maxAttempts?: number;
    /**
     * Master switch. When `false`, no wake is dispatched even if a project is
     * bound (events are still recorded durably). Defaults to `true`.
     */
    enabled?: boolean;
}
/** Tool-execution policy. */
export interface ToolsConfig {
    /** Allow sandboxed tools to reach the network. Defaults to `false`. */
    allowNetwork?: boolean;
    /**
     * Optional hard cap (ms) on a single foreground `bash` command. `null`
     * (the default, and the value when the field is omitted) means UNLIMITED:
     * a long-running build/test may run for hours. A positive finite value caps
     * every command; a per-call `timeout` may request a SHORTER limit but can
     * never exceed this cap.
     */
    commandTimeoutMs?: number | null;
}
export interface ConfigLimits {
    /** Model context window in tokens. Always a finite generation constraint. */
    contextWindow: number;
    /** Maximum output tokens per response. Always a finite generation constraint. */
    maxTokens: number;
    /**
     * Maximum agent/tool steps (provider requests) per assignment. `null` (the
     * default, and the value when the field is omitted) means UNLIMITED: the
     * assignment runs until it finishes, is cancelled, or fails. A positive
     * finite value is a hard cap.
     */
    maxSteps: number | null;
    /**
     * Per-assignment wall-clock timeout in milliseconds. `null` (the default,
     * and the value when the field is omitted) means UNLIMITED: no deadline is
     * persisted and no deadline timer is armed. A positive finite value is a
     * hard cap.
     */
    timeoutMs: number | null;
}
export interface ConfigPaths {
    /** Private runtime state directory (store, journals, socket). */
    stateDir: string;
    /**
     * Project home: the root beneath which allowed project checkouts live.
     * Must be absolute after resolution.
     */
    projectHome: string;
    /**
     * Absolute directories a worker may touch. Each entry must resolve to an
     * absolute path.
     */
    allowedRoots: string[];
}
/**
 * Credential reference. Exactly one of `apiKeyFile` or `env` must be present.
 * The value is never the key itself; resolution happens inside the trusted
 * runtime only.
 */
export interface CredentialRef {
    /** Absolute (after resolution) path to a file containing the raw API key. */
    none?: boolean;
    apiKeyFile?: string;
    /** Name of an environment variable holding the raw API key. */
    env?: string;
}
/**
 * Validated OpenAI-completions compat overrides. Field names and allowed
 * literal values mirror `OpenAICompletionsCompat` in pi-ai 1.4.0.
 */
export interface CompatOverrides {
    supportsStore?: boolean;
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
    supportsUsageInStreaming?: boolean;
    supportsFinishReason?: boolean;
    maxTokensField?: "max_completion_tokens" | "max_tokens";
    requiresToolResultName?: boolean;
    requiresAssistantAfterToolResult?: boolean;
    requiresThinkingAsText?: boolean;
    requiresReasoningContentOnAssistantMessages?: boolean;
    thinkingFormat?: "openai" | "openrouter" | "deepseek" | "together" | "baseten" | "zai" | "qwen" | "chat-template" | "qwen-chat-template" | "string-thinking" | "ant-ling";
    supportsStrictMode?: boolean;
}
/** Legacy config shape accepted by {@link loadLegacyConfig}. */
export interface LegacyConfig {
    baseUrl: string;
    model: string;
    apiKeyFile?: string;
    contextTokens: number;
    outputTokens: number;
    allowedProjects: string[];
    /** Optional legacy agent-step limit; inherited unless overridden. */
    maxSteps?: number;
    /** Optional legacy per-assignment timeout in seconds; inherited unless overridden. */
    timeoutSeconds?: number;
}
/** Optional runtime overrides layered over the legacy shape. */
export interface LegacyConfigOverrides {
    credential?: CredentialRef;
    stateDir?: string;
    projectHome?: string;
    maxSteps?: number | null;
    timeoutMs?: number | null;
    compat?: CompatOverrides;
    /** Legacy `apiKeyFile` may point at a relative path; resolved vs the legacy file. */
    configDir?: string;
}
/** Raised for every config-loading failure. Never embeds the raw config. */
export declare class ConfigError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/**
 * Load and validate a portable config file.
 *
 * Reads `path` as JSON, validates it, and resolves relative file paths against
 * the config file's own directory. Throws {@link ConfigError} (never embedding
 * the raw config) on any problem.
 */
export declare function loadConfig(path: string): Promise<PiDurableConfig>;
/** Resolve the manager CLI executable: explicit config, else `codex` on PATH. */
export declare function managerExecutable(config: PiDurableConfig): string;
/** Whether manager wake dispatch is enabled for a config. Defaults to true. */
export declare function managerEnabled(config: PiDurableConfig): boolean;
/**
 * Whether sandboxed tools may reach the network for a config.
 *
 * Defaults to `false` when unset, so a config can never accidentally grant
 * network access by omission.
 */
export declare function allowNetwork(config: PiDurableConfig): boolean;
/**
 * Resolve the optional per-command timeout cap for a config.
 *
 * Returns `null` (UNLIMITED) when unset or explicitly null: a long-running
 * foreground command may run for hours. A positive finite value caps every
 * command.
 */
export declare function commandTimeoutMs(config: PiDurableConfig): number | null;
/**
 * Load a legacy flat config shape and normalize it into {@link PiDurableConfig}.
 *
 * Legacy files use `baseUrl`/`model`/`apiKeyFile`/`contextTokens`/`outputTokens`/
 * `allowedProjects`. Runtime state (stateDir/projectHome/maxSteps/timeoutMs) is
 * NOT part of the legacy file and must be supplied via `overrides`, or defaults
 * derived from the legacy file's directory are used. Overrides take precedence.
 */
export declare function loadLegacyConfig(path: string, overrides?: LegacyConfigOverrides): Promise<PiDurableConfig>;
/**
 * Largest delay Node's `setTimeout` can represent without overflowing its
 * signed 32-bit backing field (~24.85 days). A larger value would be silently
 * clamped to 1ms (with a `TimeoutOverflowWarning`), turning a deliberate long
 * cap into an instant timeout. We therefore REJECT an explicit duration above
 * this bound rather than mis-scheduling it. `null`/omitted still means
 * UNLIMITED.
 */
export declare const MAX_TIMER_MS = 2147483647;
/**
 * Endpoint validation: HTTPS is required, except HTTP is permitted for
 * loopback hosts (127.0.0.0/8, ::1, localhost) used by test fixtures. The URL
 * must be a bare origin+path: embedded credentials (userinfo), a query string,
 * or a fragment are rejected even for HTTPS, because they would leak secrets or
 * change request semantics unexpectedly.
 */
export declare function validateEndpoint(endpoint: string, allowInsecureHttp?: boolean): void;
export declare function validateCompat(value: unknown): CompatOverrides;
//# sourceMappingURL=config.d.ts.map