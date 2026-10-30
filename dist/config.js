import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, dirname } from "node:path";
import { redactString } from "./redact.js";
/** Raised for every config-loading failure. Never embeds the raw config. */
export class ConfigError extends Error {
    code;
    constructor(code, message) {
        super(redactString(message));
        this.name = "ConfigError";
        this.code = code;
    }
}
const ALLOWED_THINKING_FORMATS = new Set([
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
const KNOWN_COMPAT_KEYS = new Set([
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
export async function loadConfig(path) {
    const configDir = dirname(resolve(path));
    let raw;
    try {
        raw = await readFile(path, "utf8");
    }
    catch {
        throw new ConfigError("read", `Unable to read config file at the given path.`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
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
    const config = {
        configVersion: 1,
        endpoint,
        model,
        limits,
        paths,
        credential,
    };
    if (parsed.compatibilityPreset !== undefined) {
        if (!["legacy-deepseek", "generic"].includes(String(parsed.compatibilityPreset)))
            throw new ConfigError("compat", "Invalid compatibility preset");
        config.compatibilityPreset = parsed.compatibilityPreset;
    }
    for (const k of ["reasoning", "allowInsecureHttp"]) {
        if (parsed[k] !== undefined) {
            if (typeof parsed[k] !== "boolean")
                throw new ConfigError("field", "Expected boolean");
            config[k] = parsed[k];
        }
    }
    if (tools !== undefined)
        config.tools = tools;
    if (manager !== undefined)
        config.manager = manager;
    if (compat !== undefined)
        config.compat = compat;
    return config;
}
/** Validate the optional `manager` wake policy object. */
function validateManager(value) {
    if (!isRecord(value)) {
        throw new ConfigError("manager", 'Field "manager" must be an object.');
    }
    const known = new Set(["cliExecutable", "cliBaseArgs", "cliTimeoutMs", "maxAttempts", "enabled"]);
    for (const key of Object.keys(value)) {
        if (!known.has(key))
            throw new ConfigError("manager", `Unknown manager field "manager.${key}".`);
    }
    const out = {};
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
        out.cliBaseArgs = value.cliBaseArgs;
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
export function managerExecutable(config) {
    return config.manager?.cliExecutable ?? "codex";
}
/** Whether manager wake dispatch is enabled for a config. Defaults to true. */
export function managerEnabled(config) {
    return config.manager?.enabled !== false;
}
/**
 * Whether sandboxed tools may reach the network for a config.
 *
 * Defaults to `false` when unset, so a config can never accidentally grant
 * network access by omission.
 */
export function allowNetwork(config) {
    return config.tools?.allowNetwork === true;
}
/**
 * Resolve the optional per-command timeout cap for a config.
 *
 * Returns `null` (UNLIMITED) when unset or explicitly null: a long-running
 * foreground command may run for hours. A positive finite value caps every
 * command.
 */
export function commandTimeoutMs(config) {
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
export async function loadLegacyConfig(path, overrides = {}) {
    const configDir = overrides.configDir ?? dirname(resolve(path));
    let raw;
    try {
        raw = await readFile(path, "utf8");
    }
    catch {
        throw new ConfigError("read", "Unable to read legacy config file at the given path.");
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
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
    const credential = overrides.credential === undefined
        ? validateCredential(parsed.apiKeyFile === undefined ? undefined : { apiKeyFile: parsed.apiKeyFile }, configDir)
        : validateCredential(overrides.credential, configDir);
    const stateDir = overrides.stateDir === undefined
        ? resolve(configDir, ".runtime")
        : requireAbsolutePath(overrides.stateDir, "override.stateDir", configDir);
    const projectHome = overrides.projectHome === undefined
        ? resolve(configDir, "projects")
        : requireAbsolutePath(overrides.projectHome, "override.projectHome", configDir);
    // Legacy step/timeout fields are inherited unless explicitly overridden.
    const inheritedMaxSteps = parsed.maxSteps === undefined ? undefined : requirePositiveInteger(parsed.maxSteps, "maxSteps");
    const inheritedTimeoutMs = parsed.timeoutSeconds === undefined
        ? undefined
        : requireOptionalTimerMs(requirePositiveInteger(parsed.timeoutSeconds, "timeoutSeconds") * 1000, "timeoutSeconds") ?? undefined;
    const limits = {
        contextWindow,
        maxTokens,
        maxSteps: overrides.maxSteps === undefined
            ? (inheritedMaxSteps ?? null)
            : requireOptionalPositiveInteger(overrides.maxSteps, "override.maxSteps"),
        timeoutMs: overrides.timeoutMs === undefined
            ? (inheritedTimeoutMs ?? null)
            : requireOptionalTimerMs(overrides.timeoutMs, "override.timeoutMs"),
    };
    assertLimitsOrder(limits.contextWindow, limits.maxTokens);
    const compat = overrides.compat === undefined ? undefined : validateCompat(overrides.compat);
    const config = {
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
    if (compat !== undefined)
        config.compat = compat;
    return config;
}
/** True when a value is a non-null object (not an array). */
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireNonEmptyString(value, field) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new ConfigError("field", `Field "${field}" must be a non-empty string.`);
    }
    return value;
}
function requirePositiveInteger(value, field) {
    if (typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value <= 0) {
        throw new ConfigError("field", `Field "${field}" must be a positive safe integer.`);
    }
    return value;
}
/**
 * A limit that is either OMITTED, explicit `null` (both meaning UNLIMITED), or
 * a positive finite safe integer. Zero, negative, NaN, non-integers, and unsafe
 * integers are rejected — there is no magic sentinel for "unlimited".
 */
function requireOptionalPositiveInteger(value, field) {
    if (value === undefined || value === null)
        return null;
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
function requireOptionalTimerMs(value, field) {
    const parsed = requireOptionalPositiveInteger(value, field);
    if (parsed !== null && parsed > MAX_TIMER_MS) {
        throw new ConfigError("field", `Field "${field}" must be null (unlimited) or a positive integer no greater than ${MAX_TIMER_MS}ms.`);
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
export function validateEndpoint(endpoint, allowInsecureHttp = false) {
    let url;
    try {
        url = new URL(endpoint);
    }
    catch {
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
    if (url.protocol === "https:")
        return;
    if (url.protocol === "http:" && (allowInsecureHttp || isLoopbackHost(url.hostname)))
        return;
    throw new ConfigError("endpoint", "Endpoint must use HTTPS (HTTP is only allowed for loopback test hosts).");
}
function isLoopbackHost(hostname) {
    const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || host === "::1")
        return true;
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host))
        return true;
    return false;
}
/**
 * A response cannot reserve more tokens than the model's context window; such a
 * config could never satisfy a single request, so it is rejected at load time.
 */
function assertLimitsOrder(contextWindow, maxTokens) {
    if (maxTokens >= contextWindow) {
        throw new ConfigError("limits", "limits.maxTokens must be smaller than limits.contextWindow.");
    }
}
function validateLimits(value) {
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
function validatePaths(value, configDir) {
    if (!isRecord(value)) {
        throw new ConfigError("paths", "Field \"paths\" must be an object.");
    }
    const stateDir = requireAbsolutePath(value.stateDir, "paths.stateDir", configDir);
    const projectHome = requireAbsolutePath(value.projectHome, "paths.projectHome", configDir);
    if (!Array.isArray(value.allowedRoots)) {
        throw new ConfigError("paths", "Field \"paths.allowedRoots\" must be an array of paths.");
    }
    const allowedRoots = value.allowedRoots.map((entry, i) => requireAbsolutePath(entry, `paths.allowedRoots[${i}]`, configDir));
    return { stateDir, projectHome, allowedRoots };
}
function requireAbsolutePath(value, field, configDir) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new ConfigError("path", `Field "${field}" must be a non-empty path string.`);
    }
    const resolved = isAbsolute(value) ? value : resolve(configDir, value);
    if (!isAbsolute(resolved)) {
        throw new ConfigError("path", `Field "${field}" must resolve to an absolute path.`);
    }
    return resolved;
}
function requireAbsoluteStringArray(value, field, configDir) {
    if (!Array.isArray(value)) {
        throw new ConfigError("path", `Field "${field}" must be an array of paths.`);
    }
    return value.map((entry, i) => requireAbsolutePath(entry, `${field}[${i}]`, configDir));
}
function validateCredential(value, configDir) {
    if (!isRecord(value)) {
        throw new ConfigError("credential", "Field \"credential\" must be an object.");
    }
    if (isRecord(value) && value.none === true && Object.keys(value).length === 1)
        return { none: true };
    if (value.none !== undefined)
        throw new ConfigError("credential", "No-auth must be used alone with none: true");
    const hasFile = value.apiKeyFile !== undefined;
    const hasEnv = value.env !== undefined;
    if (hasFile === hasEnv) {
        throw new ConfigError("credential", "Credential must set exactly one of \"apiKeyFile\" or \"env\".");
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
function validateEnvName(value) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new ConfigError("credential", "Credential env name must be a non-empty string.");
    }
    if (!ENV_NAME.test(value)) {
        throw new ConfigError("credential", "Credential env name must be a valid environment variable name.");
    }
    return value;
}
/** Validate the optional `tools` policy object. */
function validateTools(value) {
    if (!isRecord(value)) {
        throw new ConfigError("tools", "Field \"tools\" must be an object.");
    }
    for (const key of Object.keys(value)) {
        if (key !== "allowNetwork" && key !== "commandTimeoutMs") {
            throw new ConfigError("tools", `Unknown tools field "tools.${key}".`);
        }
    }
    const out = {};
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
        out.commandTimeoutMs = requireOptionalTimerMs(value.commandTimeoutMs, "tools.commandTimeoutMs");
    }
    return out;
}
export function validateCompat(value) {
    if (!isRecord(value)) {
        throw new ConfigError("compat", "Field \"compat\" must be an object.");
    }
    for (const key of Object.keys(value)) {
        if (!KNOWN_COMPAT_KEYS.has(key)) {
            throw new ConfigError("compat", `Unknown compat field "compat.${key}".`);
        }
    }
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
        const k = key;
        if (k === "thinkingFormat") {
            if (typeof raw !== "string" || !ALLOWED_THINKING_FORMATS.has(raw)) {
                throw new ConfigError("compat", "compat.thinkingFormat is not a recognized value.");
            }
            out.thinkingFormat = raw;
        }
        else if (k === "maxTokensField") {
            if (raw !== "max_completion_tokens" && raw !== "max_tokens") {
                throw new ConfigError("compat", "compat.maxTokensField must be \"max_completion_tokens\" or \"max_tokens\".");
            }
            out.maxTokensField = raw;
        }
        else {
            if (typeof raw !== "boolean") {
                throw new ConfigError("compat", `compat.${key} must be a boolean.`);
            }
            out[key] = raw;
        }
    }
    return out;
}
//# sourceMappingURL=config.js.map