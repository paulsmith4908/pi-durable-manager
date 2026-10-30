import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, dirname } from "node:path";
import { redactString } from "./redact.js";

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
  thinkingFormat?:
    | "openai"
    | "openrouter"
    | "deepseek"
    | "together"
    | "baseten"
    | "zai"
    | "qwen"
    | "chat-template"
    | "qwen-chat-template"
    | "string-thinking"
    | "ant-ling";
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
export class ConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(redactString(message));
    this.name = "ConfigError";
    this.code = code;
  }
}

const ALLOWED_THINKING_FORMATS = new Set<NonNullable<CompatOverrides["thinkingFormat"]>>([
  "openai",
  "openrouter",
  "deepseek",
  "together",
  "baseten",
  "zai",
  "qwen",
  "chat-template",
  "qwen-chat-template",
  "string-thinking",
  "ant-ling",
]);

const KNOWN_COMPAT_KEYS = new Set<keyof CompatOverrides>([
  "supportsStore",
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "supportsUsageInStreaming",
  "supportsFinishReason",
  "maxTokensField",
  "requiresToolResultName",
  "requiresAssistantAfterToolResult",
  "requiresThinkingAsText",
  "requiresReasoningContentOnAssistantMessages",
  "thinkingFormat",
  "supportsStrictMode",
]);

/**
 * Load and validate a portable config file.
 *
 * Reads `path` as JSON, validates it, and resolves relative file paths against
 * the config file's own directory. Throws {@link ConfigError} (never embedding
 * the raw config) on any problem.
 */
export async function loadConfig(path: string): Promise<PiDurableConfig> {
  const configDir = dirname(resolve(path));

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new ConfigError("read", `Unable to read config file at the given path.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError("parse", "Config file is not valid JSON.");
  }

  if (!isRecord(parsed)) {
    throw new ConfigError("shape", "Config root must be a JSON object.");
  }

  if (parsed.configVersion !== 1) {
    throw new ConfigError("version", "Unsupported or missing configVersion (expected 1).");
  }

  const endpoint = requireNonEmptyString(parsed.endpoint, "endpoint");
  validateEndpoint(endpoint, parsed.allowInsecureHttp === true);

  const model = requireNonEmptyString(parsed.model, "model");

  const limits = validateLimits(parsed.limits);
  assertLimitsOrder(limits.contextWindow, limits.maxTokens);
  const paths = validatePaths(parsed.paths, configDir);
  const credential = validateCredential(parsed.credential, configDir);
  const tools = parsed.tools === undefined ? undefined : validateTools(parsed.tools);
  const manager = parsed.manager === undefined ? undefined : validateManager(parsed.manager);
  const compat = parsed.compat === undefined ? undefined : validateCompat(parsed.compat);

  const config: PiDurableConfig = {
    configVersion: 1,
    endpoint,
    model,
    limits,
    paths,
    credential,
  };
  if (parsed.compatibilityPreset !== undefined) { if (!["legacy-deepseek", "generic"].includes(String(parsed.compatibilityPreset))) throw new ConfigError("compat", "Invalid compatibility preset"); config.compatibilityPreset = parsed.compatibilityPreset as any; }
  for (const k of ["reasoning", "allowInsecureHttp"] as const) { if (parsed[k] !== undefined) { if (typeof parsed[k] !== "boolean") throw new ConfigError("field", "Expected boolean"); config[k] = parsed[k]; } }
  if (tools !== undefined) config.tools = tools;
  if (manager !== undefined) config.manager = manager;
  if (compat !== undefined) config.compat = compat;
  return config;
}

/** Validate the optional `manager` wake policy object. */
function validateManager(value: unknown): ManagerConfig {
  if (!isRecord(value)) {
    throw new ConfigError("manager", 'Field "manager" must be an object.');
  }
  const known = new Set(["cliExecutable", "cliBaseArgs", "cliTimeoutMs", "maxAttempts", "enabled"]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) throw new ConfigError("manager", `Unknown manager field "manager.${key}".`);
  }
  const out: ManagerConfig = {};
  if (value.cliExecutable !== undefined) {
    if (typeof value.cliExecutable !== "string" || value.cliExecutable.trim() === "") {
      throw new ConfigError("manager", "manager.cliExecutable must be a non-empty string.");
    }
    out.cliExecutable = value.cliExecutable;
  }
  if (value.cliBaseArgs !== undefined) {
    if (!Array.isArray(value.cliBaseArgs) || value.cliBaseArgs.some((a) => typeof a !== "string")) {
      throw new ConfigError("manager", "manager.cliBaseArgs must be an array of strings.");
    }
    out.cliBaseArgs = value.cliBaseArgs as string[];
  }
  if (value.cliTimeoutMs !== undefined) {
    out.cliTimeoutMs = requirePositiveInteger(value.cliTimeoutMs, "manager.cliTimeoutMs");
  }
  if (value.maxAttempts !== undefined) {
    out.maxAttempts = requirePositiveInteger(value.maxAttempts, "manager.maxAttempts");
  }
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") {
      throw new ConfigError("manager", "manager.enabled must be a boolean.");
    }
    out.enabled = value.enabled;
  }
  return out;
}

/** Resolve the manager CLI executable: explicit config, else `codex` on PATH. */
export function managerExecutable(config: PiDurableConfig): string {
  return config.manager?.cliExecutable ?? "codex";
}

/** Whether manager wake dispatch is enabled for a config. Defaults to true. */
export function managerEnabled(config: PiDurableConfig): boolean {
  return config.manager?.enabled !== false;
}

/**
 * Whether sandboxed tools may reach the network for a config.
 *
 * Defaults to `false` when unset, so a config can never accidentally grant
 * network access by omission.
 */
export function allowNetwork(config: PiDurableConfig): boolean {
  return config.tools?.allowNetwork === true;
}

/**
 * Resolve the optional per-command timeout cap for a config.
 *
 * Returns `null` (UNLIMITED) when unset or explicitly null: a long-running
 * foreground command may run for hours. A positive finite value caps every
 * command.
 */
export function commandTimeoutMs(config: PiDurableConfig): number | null {
  return config.tools?.commandTimeoutMs ?? null;
}

/**
 * Load a legacy flat config shape and normalize it into {@link PiDurableConfig}.
 *
 * Legacy files use `baseUrl`/`model`/`apiKeyFile`/`contextTokens`/`outputTokens`/
 * `allowedProjects`. Runtime state (stateDir/projectHome/maxSteps/timeoutMs) is
 * NOT part of the legacy file and must be supplied via `overrides`, or defaults
 * derived from the legacy file's directory are used. Overrides take precedence.
 */
export async function loadLegacyConfig(
  path: string,
  overrides: LegacyConfigOverrides = {},
): Promise<PiDurableConfig> {
  const configDir = overrides.configDir ?? dirname(resolve(path));

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new ConfigError("read", "Unable to read legacy config file at the given path.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError("parse", "Legacy config file is not valid JSON.");
  }
  if (!isRecord(parsed)) {
    throw new ConfigError("shape", "Legacy config root must be a JSON object.");
  }

  const baseUrl = requireNonEmptyString(parsed.baseUrl, "baseUrl");
  validateEndpoint(baseUrl);
  const model = requireNonEmptyString(parsed.model, "model");

  const contextWindow = requirePositiveInteger(parsed.contextTokens, "contextTokens");
  const maxTokens = requirePositiveInteger(parsed.outputTokens, "outputTokens");
  assertLimitsOrder(contextWindow, maxTokens);

  const allowedProjects = requireAbsoluteStringArray(parsed.allowedProjects, "allowedProjects", configDir);

  // Overrides are normalized through the same validators as file-loaded values,
  // so an override cannot bypass credential/path/limit validation.
  const credential =
    overrides.credential === undefined
      ? validateCredential(
          parsed.apiKeyFile === undefined ? undefined : { apiKeyFile: parsed.apiKeyFile },
          configDir,
        )
      : validateCredential(overrides.credential, configDir);

  const stateDir =
    overrides.stateDir === undefined
      ? resolve(configDir, ".runtime")
      : requireAbsolutePath(overrides.stateDir, "override.stateDir", configDir);
  const projectHome =
    overrides.projectHome === undefined
      ? resolve(configDir, "projects")
      : requireAbsolutePath(overrides.projectHome, "override.projectHome", configDir);

  // Legacy step/timeout fields are inherited unless explicitly overridden.
  const inheritedMaxSteps =
    parsed.maxSteps === undefined ? undefined : requirePositiveInteger(parsed.maxSteps, "maxSteps");
  const inheritedTimeoutMs =
    parsed.timeoutSeconds === undefined
      ? undefined
      : requireOptionalTimerMs(
          requirePositiveInteger(parsed.timeoutSeconds, "timeoutSeconds") * 1000,
          "timeoutSeconds",
        ) ?? undefined;

  const limits: ConfigLimits = {
    contextWindow,
    maxTokens,
    maxSteps:
      overrides.maxSteps === undefined
        ? (inheritedMaxSteps ?? null)
        : requireOptionalPositiveInteger(overrides.maxSteps, "override.maxSteps"),
    timeoutMs:
      overrides.timeoutMs === undefined
        ? (inheritedTimeoutMs ?? null)
        : requireOptionalTimerMs(overrides.timeoutMs, "override.timeoutMs"),
  };
  assertLimitsOrder(limits.contextWindow, limits.maxTokens);

  const compat = overrides.compat === undefined ? undefined : validateCompat(overrides.compat);

  const config: PiDurableConfig = {
    configVersion: 1,
    endpoint: baseUrl,
    model,
    limits,
    paths: {
      stateDir,
      projectHome,
      allowedRoots: allowedProjects,
    },
    credential,
  };
  if (compat !== undefined) config.compat = compat;
  return config;
}

/** True when a value is a non-null object (not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError("field", `Field "${field}" must be a non-empty string.`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new ConfigError("field", `Field "${field}" must be a positive safe integer.`);
  }
  return value;
}

/**
 * A limit that is either OMITTED, explicit `null` (both meaning UNLIMITED), or
 * a positive finite safe integer. Zero, negative, NaN, non-integers, and unsafe
 * integers are rejected — there is no magic sentinel for "unlimited".
 */
function requireOptionalPositiveInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  return requirePositiveInteger(value, field);
}

/**
 * Largest delay Node's `setTimeout` can represent without overflowing its
 * signed 32-bit backing field (~24.85 days). A larger value would be silently
 * clamped to 1ms (with a `TimeoutOverflowWarning`), turning a deliberate long
 * cap into an instant timeout. We therefore REJECT an explicit duration above
 * this bound rather than mis-scheduling it. `null`/omitted still means
 * UNLIMITED.
 */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * A DURATION limit (as opposed to a count) that is either OMITTED, explicit
 * `null` (both meaning UNLIMITED), or a positive finite safe integer that fits
 * Node's timer range. Rejects overflow-sized values so a long chosen timeout is
 * never silently clamped to ~1ms.
 */
function requireOptionalTimerMs(value: unknown, field: string): number | null {
  const parsed = requireOptionalPositiveInteger(value, field);
  if (parsed !== null && parsed > MAX_TIMER_MS) {
    throw new ConfigError(
      "field",
      `Field "${field}" must be null (unlimited) or a positive integer no greater than ${MAX_TIMER_MS}ms.`,
    );
  }
  return parsed;
}

/**
 * Endpoint validation: HTTPS is required, except HTTP is permitted for
 * loopback hosts (127.0.0.0/8, ::1, localhost) used by test fixtures. The URL
 * must be a bare origin+path: embedded credentials (userinfo), a query string,
 * or a fragment are rejected even for HTTPS, because they would leak secrets or
 * change request semantics unexpectedly.
 */
export function validateEndpoint(endpoint: string, allowInsecureHttp = false): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ConfigError("endpoint", "Endpoint must be a valid absolute URL.");
  }

  if (url.username !== "" || url.password !== "") {
    throw new ConfigError("endpoint", "Endpoint must not embed credentials (userinfo).");
  }
  if (url.search !== "") {
    throw new ConfigError("endpoint", "Endpoint must not include a query string.");
  }
  if (url.hash !== "") {
    throw new ConfigError("endpoint", "Endpoint must not include a fragment.");
  }

  if (url.protocol === "https:") return;

  if (url.protocol === "http:" && (allowInsecureHttp || isLoopbackHost(url.hostname))) return;

  throw new ConfigError(
    "endpoint",
    "Endpoint must use HTTPS (HTTP is only allowed for loopback test hosts).",
  );
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

/**
 * A response cannot reserve more tokens than the model's context window; such a
 * config could never satisfy a single request, so it is rejected at load time.
 */
function assertLimitsOrder(contextWindow: number, maxTokens: number): void {
  if (maxTokens >= contextWindow) {
    throw new ConfigError(
      "limits",
      "limits.maxTokens must be smaller than limits.contextWindow.",
    );
  }
}

function validateLimits(value: unknown): ConfigLimits {
  if (!isRecord(value)) {
    throw new ConfigError("limits", "Field \"limits\" must be an object.");
  }
  return {
    contextWindow: requirePositiveInteger(value.contextWindow, "limits.contextWindow"),
    maxTokens: requirePositiveInteger(value.maxTokens, "limits.maxTokens"),
    // Omitted or explicit null => unlimited. Positive finite safe integers are
    // still accepted for backward compatibility.
    maxSteps: requireOptionalPositiveInteger(value.maxSteps, "limits.maxSteps"),
    timeoutMs: requireOptionalTimerMs(value.timeoutMs, "limits.timeoutMs"),
  };
}

function validatePaths(value: unknown, configDir: string): ConfigPaths {
  if (!isRecord(value)) {
    throw new ConfigError("paths", "Field \"paths\" must be an object.");
  }
  const stateDir = requireAbsolutePath(value.stateDir, "paths.stateDir", configDir);
  const projectHome = requireAbsolutePath(value.projectHome, "paths.projectHome", configDir);

  if (!Array.isArray(value.allowedRoots)) {
    throw new ConfigError("paths", "Field \"paths.allowedRoots\" must be an array of paths.");
  }
  const allowedRoots = value.allowedRoots.map((entry, i) =>
    requireAbsolutePath(entry, `paths.allowedRoots[${i}]`, configDir),
  );

  return { stateDir, projectHome, allowedRoots };
}

function requireAbsolutePath(value: unknown, field: string, configDir: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError("path", `Field "${field}" must be a non-empty path string.`);
  }
  const resolved = isAbsolute(value) ? value : resolve(configDir, value);
  if (!isAbsolute(resolved)) {
    throw new ConfigError("path", `Field "${field}" must resolve to an absolute path.`);
  }
  return resolved;
}

function requireAbsoluteStringArray(value: unknown, field: string, configDir: string): string[] {
  if (!Array.isArray(value)) {
    throw new ConfigError("path", `Field "${field}" must be an array of paths.`);
  }
  return value.map((entry, i) => requireAbsolutePath(entry, `${field}[${i}]`, configDir));
}

function validateCredential(value: unknown, configDir: string): CredentialRef {
  if (!isRecord(value)) {
    throw new ConfigError("credential", "Field \"credential\" must be an object.");
  }

  if (isRecord(value) && value.none === true && Object.keys(value).length === 1) return { none: true };
  if (value.none !== undefined) throw new ConfigError("credential", "No-auth must be used alone with none: true");
  const hasFile = value.apiKeyFile !== undefined;
  const hasEnv = value.env !== undefined;

  if (hasFile === hasEnv) {
    throw new ConfigError(
      "credential",
      "Credential must set exactly one of \"apiKeyFile\" or \"env\".",
    );
  }

  if (hasFile) {
    const apiKeyFile = requireAbsolutePath(value.apiKeyFile, "credential.apiKeyFile", configDir);
    return { apiKeyFile };
  }

  return { env: validateEnvName(value.env) };
}

/** An environment variable name: ASCII letters, digits, underscore; not starting with a digit. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate a credential environment variable name syntactically. This is
 * unconditional: a name that merely "looks secret" (e.g. contains a hyphen or
 * is entirely numeric) is still rejected, because only real, addressable
 * environment names are acceptable.
 */
function validateEnvName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError("credential", "Credential env name must be a non-empty string.");
  }
  if (!ENV_NAME.test(value)) {
    throw new ConfigError("credential", "Credential env name must be a valid environment variable name.");
  }
  return value;
}

/** Validate the optional `tools` policy object. */
function validateTools(value: unknown): ToolsConfig {
  if (!isRecord(value)) {
    throw new ConfigError("tools", "Field \"tools\" must be an object.");
  }
  for (const key of Object.keys(value)) {
    if (key !== "allowNetwork" && key !== "commandTimeoutMs") {
      throw new ConfigError("tools", `Unknown tools field "tools.${key}".`);
    }
  }
  const out: ToolsConfig = {};
  if (value.allowNetwork !== undefined) {
    if (typeof value.allowNetwork !== "boolean") {
      throw new ConfigError("tools", "tools.allowNetwork must be a boolean.");
    }
    out.allowNetwork = value.allowNetwork;
  }
  // Omitted or explicit null => unlimited (no per-command cap). A positive
  // finite safe integer caps every foreground command; overflow-sized values
  // are rejected rather than silently clamped to ~1ms by Node's timer.
  if (value.commandTimeoutMs !== undefined) {
    out.commandTimeoutMs = requireOptionalTimerMs(
      value.commandTimeoutMs,
      "tools.commandTimeoutMs",
    );
  }
  return out;
}

export function validateCompat(value: unknown): CompatOverrides {
  if (!isRecord(value)) {
    throw new ConfigError("compat", "Field \"compat\" must be an object.");
  }

  for (const key of Object.keys(value)) {
    if (!KNOWN_COMPAT_KEYS.has(key as keyof CompatOverrides)) {
      throw new ConfigError("compat", `Unknown compat field "compat.${key}".`);
    }
  }

  const out: CompatOverrides = {};
  for (const [key, raw] of Object.entries(value)) {
    const k = key as keyof CompatOverrides;
    if (k === "thinkingFormat") {
      if (typeof raw !== "string" || !ALLOWED_THINKING_FORMATS.has(raw as never)) {
        throw new ConfigError("compat", "compat.thinkingFormat is not a recognized value.");
      }
      out.thinkingFormat = raw as CompatOverrides["thinkingFormat"];
    } else if (k === "maxTokensField") {
      if (raw !== "max_completion_tokens" && raw !== "max_tokens") {
        throw new ConfigError("compat", "compat.maxTokensField must be \"max_completion_tokens\" or \"max_tokens\".");
      }
      out.maxTokensField = raw;
    } else {
      if (typeof raw !== "boolean") {
        throw new ConfigError("compat", `compat.${key} must be a boolean.`);
      }
      (out as Record<string, unknown>)[key] = raw;
    }
  }
  return out;
}
