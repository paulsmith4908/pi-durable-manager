/**
 * Real Pi Durable probe — the M0/M1 integration harness.
 *
 * This is the ONLY runnable entry point in this repository that talks to a
 * real durable SQLite store and a real provider. It is intentionally narrow:
 *
 *   1. Resolve the operator's config (portable or legacy) and credential.
 *   2. Open file-backed durable storage with an ownership lock.
 *   3. Register a single replay-safe `probe_echo` tool.
 *   4. Submit one instruction that must use the tool exactly once and then
 *      answer with the nonce.
 *   5. Wait (bounded), classify the terminal state, then close and reopen the
 *      same store and prove the submission is idempotent (same IDs, no extra
 *      model call).
 *   6. Emit a single JSON line, with any provider error redacted, and exit
 *      non-zero on failure.
 *
 * It never prints the API key, and never runs arbitrary shell commands.
 *
 * Usage:
 *   node dist/probe.js --config FILE [--state-dir DIR] [--timeout-ms N]
 *   node dist/probe.js --legacy-config FILE --state-dir DIR [--timeout-ms N]
 */
import { type Context } from "@earendil-works/chord/context";
import { type Conversation, type EntryRecord, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai";
import { type PiDurableConfig } from "./config.js";
import { type RedactedCredential, type ResolvedCredential } from "./credential.js";
/** Default bounded wait for the single probe submission. */
export declare const DEFAULT_PROBE_TIMEOUT_MS = 60000;
/** The name of the single replay-safe tool the probe registers. */
export declare const PROBE_TOOL_NAME = "probe_echo";
/** Prefix for the per-run unique request id used for the probe submission. */
export declare const PROBE_REQUEST_ID_PREFIX = "pi-durable-probe";
/** Result of one probe run; the shape serialized to stdout. */
export interface ProbeResult {
    readonly ok: boolean;
    readonly model: string;
    readonly conversationId: string;
    readonly submissionId: string;
    readonly requestId: string;
    readonly toolCalls: number;
    readonly reopened: boolean;
    readonly idempotent: boolean;
    readonly stopReason: string | null;
    readonly error?: string;
}
/** A parsed set of probe command-line options. */
export interface ProbeOptions {
    readonly configFile?: string;
    readonly legacyConfigFile?: string;
    readonly stateDir?: string;
    readonly timeoutMs: number;
}
/**
 * Injectable dependencies for {@link runProbe}.
 *
 * Production callers omit this and get the real Modal-only model catalogue and
 * the real process environment. Tests may pass a faux provider catalogue and an
 * env reader so the whole flow runs against the real SDK and SQLite without a
 * network call or a real key. This is NOT a production fallback: nothing here
 * changes behavior unless explicitly supplied.
 */
export interface ProbeHost {
    /** Build the pi-ai `Models` catalogue for this run. */
    readonly createModels?: (config: PiDurableConfig, credential: ResolvedCredential) => Models;
    /** Resolve the credential from its reference. Defaults to the process env. */
    readonly resolveCredential?: (ref: PiDurableConfig["credential"]) => Promise<ResolvedCredential>;
    /** Provider id the agent model resolves against. Defaults to the Modal provider id. */
    readonly providerId?: string;
    /** Override the probe nonce (deterministic tests). Defaults to a random UUID. */
    readonly nonce?: string;
}
/** Raised for probe usage/setup problems. Message is safe to print. */
export declare class ProbeError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/**
 * Parse `argv` (already sliced past `node script`) into options.
 *
 * `--state-dir` is accepted for either config form; for `--legacy-config` it is
 * required (legacy files carry no state directory).
 */
export declare function parseProbeArgs(argv: readonly string[]): ProbeOptions;
/** JSON-safe snapshot of the probe's terminal outcome. */
interface TerminalInfo {
    readonly stopReason: string | null;
    /** True only when the final assistant message is a normal `stop`. */
    readonly stopped: boolean;
    readonly toolCalls: number;
    /** True when the final assistant text echoes the expected nonce. */
    readonly echoedNonce: boolean;
}
/**
 * Inspect committed entries: count model tool calls, read the final assistant
 * stop reason, and check that the final assistant text echoes `expectedNonce`.
 *
 * `EntryRecord.model` is an ARRAY of model messages, so each entry may
 * contribute several; we walk them all in order and keep the LAST assistant
 * message as the terminal one. Pure read, so it can be reused after a reopen.
 */
export declare function inspectEntries(entries: readonly EntryRecord[], expectedNonce: string): TerminalInfo;
/** Build the single replay-safe probe tool with an in-memory call counter. */
export declare function buildProbeTool(counter: {
    calls: number;
}): ToolRegistration;
/** Extension wrapping the single probe tool, installable in a registry. */
export declare function buildProbeExtension(counter: {
    calls: number;
}): import("@earendil-works/pi-durable").Extension<ToolRegistration>;
/** The instruction the probe submits; names the tool and the nonce. */
export declare function buildInstruction(nonce: string): string;
/**
 * Run the probe once: open, submit, wait, classify, close, reopen, verify
 * idempotence, and return the JSON-safe result.
 */
export declare function runProbe(options: ProbeOptions, host?: ProbeHost): Promise<ProbeResult>;
/** Safe, key-free summary used by tests and diagnostics. */
export declare function describeProbeCredential(credential: ResolvedCredential): RedactedCredential;
/** CLI entry point. Prints one JSON line and returns the process exit code. */
export declare function main(argv: readonly string[]): Promise<number>;
export type { Context, Conversation };
//# sourceMappingURL=probe.d.ts.map