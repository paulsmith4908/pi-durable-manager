/**
 * pi-durable-manager — public foundation API.
 *
 * This slice covers configuration loading, credential resolution, the single
 * pinned Modal provider, the application metadata store, the durable local
 * service, and its scriptable client. Assignment execution and the root CLI
 * remain reserved for later workers.
 */
export { loadConfig, loadLegacyConfig, validateEndpoint, ConfigError, managerExecutable, managerEnabled, type PiDurableConfig, type ConfigLimits, type ConfigPaths, type CredentialRef, type ManagerConfig, type CompatOverrides, type LegacyConfig, type LegacyConfigOverrides, } from "./config.js";
export { resolveCredential, redactCredential, CredentialError, type ResolvedCredential, type RedactedCredential, type EnvReader, type ResolveCredentialOptions, } from "./credential.js";
export { createModalModels, createModalProvider, buildModalModel, describeProvider, DEEPSEEK_COMPAT, MODAL_API, MODAL_PROVIDER_ID, } from "./provider.js";
export { REDACTED, redactString, redactHeaders, redactError, isSecretEnvName, type KnownSecrets, } from "./redact.js";
export { MetadataStore, StoreError, SCHEMA_VERSION, canonicalJson, payloadHash, type JournalRecord, type JournalStatus, type ProjectRecord, type SessionRecord, type AssignmentRecord, type AssignmentState, type ProcessReceipt, type ProcessReceiptState, type ServiceRunRecord, type ManagerBindingRecord, type ManagerEventRecord, type ManagerEventDelivery, TERMINAL_ASSIGNMENT_STATES, } from "./store.js";
export { AssignmentEngine, AssignmentError, buildInstructions, mapSettledStatus, isTerminal, type AssignmentEngineOptions, type AssignmentSummary, type AssignmentDetail, type SubmitResult, } from "./assignments.js";
export { PiDurableService, OwnerLock, ServiceError, PROTOCOL_VERSION, MAX_FRAME_BYTES, DEFAULT_CALL_TIMEOUT_MS, resolveRuntimeDir, resolveSocketPath, installSignalHandlers, serveMain, type ServiceHost, type ServiceStartOptions, type ServiceStatusReport, type ServiceCapabilities, type OperationDescriptor, type RpcRequest, type RpcResponse, type RpcErrorPayload, type RpcValue, } from "./service.js";
export { PiClient, PiClientError, configSocketPath, DEFAULT_CLIENT_TIMEOUT_MS, MAX_RESPONSE_BYTES, type PiClientOptions, type PiClientEnvelope, type PiClientFailure, } from "./client.js";
export { createProjectTools, createProjectExtension, previewSandboxEnv, ToolError, ProcessTracker, DEFAULT_READ_MAX_BYTES, type ProjectTools, type CreateProjectToolsOptions, type ToolPolicy, type ResolvedToolPolicy, type CommandResult, type ProcessHooks, } from "./tools.js";
export { buildSandboxProfile, buildSandboxEnv, resolvePolicy, resolveWithinRoot, readFileNoFollow, writeFileNoFollow, runSandboxedCommand, canApplyProfile, canApplyPolicyProfile, resetSandboxProbe, isWithin, SANDBOX_EXEC, O_NOFOLLOW, PROTECTED_NAMES, type ToolErrorCode, } from "./sandbox.js";
//# sourceMappingURL=index.d.ts.map