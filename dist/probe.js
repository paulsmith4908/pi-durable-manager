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
import { chmod, mkdir, open as openFile, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, defineTool, Harness, } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "@earendil-works/pi-ai";
import { loadConfig, loadLegacyConfig, } from "./config.js";
import { redactCredential, resolveCredential, } from "./credential.js";
import { createModalModels, MODAL_PROVIDER_ID, configuredProviderId } from "./provider.js";
import { redactError } from "./redact.js";
/** Default bounded wait for the single probe submission. */
export const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
/** The name of the single replay-safe tool the probe registers. */
export const PROBE_TOOL_NAME = "probe_echo";
/** Prefix for the per-run unique request id used for the probe submission. */
export const PROBE_REQUEST_ID_PREFIX = "pi-durable-probe";
/**
 * File name of the ownership lock inside the probe state directory. Kept
 * distinct from the SQLite store so the two never collide.
 */
const LOCK_FILE_NAME = "probe.lock";
/** Raised for probe usage/setup problems. Message is safe to print. */
export class ProbeError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "ProbeError";
        this.code = code;
    }
}
/**
 * Parse `argv` (already sliced past `node script`) into options.
 *
 * `--state-dir` is accepted for either config form; for `--legacy-config` it is
 * required (legacy files carry no state directory).
 */
export function parseProbeArgs(argv) {
    let configFile;
    let legacyConfigFile;
    let stateDir;
    let timeoutMs = DEFAULT_PROBE_TIMEOUT_MS;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = () => {
            const value = argv[i + 1];
            if (value === undefined)
                throw new ProbeError("args", `Missing value for ${arg}.`);
            i += 1;
            return value;
        };
        switch (arg) {
            case "--config":
                configFile = next();
                break;
            case "--legacy-config":
                legacyConfigFile = next();
                break;
            case "--state-dir":
                stateDir = next();
                break;
            case "--timeout-ms": {
                const raw = next();
                const parsed = Number(raw);
                if (!Number.isInteger(parsed) || parsed <= 0) {
                    throw new ProbeError("args", "--timeout-ms must be a positive integer.");
                }
                timeoutMs = parsed;
                break;
            }
            default:
                throw new ProbeError("args", `Unknown argument: ${arg}`);
        }
    }
    const hasConfig = configFile !== undefined;
    const hasLegacy = legacyConfigFile !== undefined;
    if (hasConfig === hasLegacy) {
        throw new ProbeError("args", "Provide exactly one of --config or --legacy-config.");
    }
    if (hasLegacy && stateDir === undefined) {
        throw new ProbeError("args", "--legacy-config requires --state-dir.");
    }
    return { configFile, legacyConfigFile, stateDir, timeoutMs };
}
/**
 * Load the operator config from whichever form was supplied.
 *
 * `--state-dir`, when given, overrides `paths.stateDir` for BOTH forms; the
 * portable branch previously ignored it.
 */
async function loadProbeConfig(options) {
    if (options.configFile !== undefined) {
        const config = await loadConfig(options.configFile);
        if (options.stateDir === undefined)
            return config;
        return { ...config, paths: { ...config.paths, stateDir: resolve(options.stateDir) } };
    }
    const legacyFile = options.legacyConfigFile;
    const overrides = {
        stateDir: options.stateDir,
        timeoutMs: options.timeoutMs,
    };
    return loadLegacyConfig(legacyFile, overrides);
}
/**
 * Inspect committed entries: count model tool calls, read the final assistant
 * stop reason, and check that the final assistant text echoes `expectedNonce`.
 *
 * `EntryRecord.model` is an ARRAY of model messages, so each entry may
 * contribute several; we walk them all in order and keep the LAST assistant
 * message as the terminal one. Pure read, so it can be reused after a reopen.
 */
export function inspectEntries(entries, expectedNonce) {
    let toolCalls = 0;
    let stopReason = null;
    let finalText = "";
    for (const entry of entries) {
        for (const message of entry.model ?? []) {
            if (message.role !== "assistant")
                continue;
            for (const part of message.content) {
                if (part.type === "toolCall") {
                    toolCalls += 1;
                }
            }
            stopReason = message.stopReason;
            finalText = message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("");
        }
    }
    const echoedNonce = expectedNonce !== "" && finalText.includes(`nonce=${expectedNonce}`);
    return { stopReason, stopped: stopReason === "stop", toolCalls, echoedNonce };
}
/** Acquire an exclusive ownership lock file in `stateDir`. */
async function acquireLock(stateDir) {
    const lockPath = resolve(stateDir, LOCK_FILE_NAME);
    let handle;
    try {
        handle = await openFile(lockPath, "wx", 0o600);
    }
    catch (error) {
        const code = error.code;
        if (code !== "EEXIST") {
            throw new ProbeError("locked", `Unable to create probe lock in ${stateDir}.`);
        }
        // A lock already exists. Never blindly unlink: read the recorded owner PID
        // and only remove the lock when that process is provably gone. If the owner
        // is still alive, or the content is unreadable, refuse explicitly.
        const stale = await isStaleLock(lockPath);
        if (!stale) {
            throw new ProbeError("locked", `Probe state directory is already in use: ${stateDir}`);
        }
        await rm(lockPath, { force: true });
        try {
            handle = await openFile(lockPath, "wx", 0o600);
        }
        catch {
            throw new ProbeError("locked", `Probe state directory is already in use: ${stateDir}`);
        }
    }
    await handle.writeFile(String(process.pid));
    let released = false;
    return {
        release: async () => {
            if (released)
                return;
            released = true;
            await handle.close().catch(() => undefined);
            // Only remove the lock while we still own it.
            await rm(lockPath, { force: true }).catch(() => undefined);
        },
    };
}
/** True when the lock file names a PID that is no longer running. */
async function isStaleLock(lockPath) {
    let contents;
    try {
        contents = await readFile(lockPath, "utf8");
    }
    catch {
        return false;
    }
    const pid = Number(contents.trim());
    if (!Number.isInteger(pid) || pid <= 0) {
        // Unreadable or malformed contents: refuse rather than guess.
        return false;
    }
    if (pid === process.pid)
        return true;
    try {
        process.kill(pid, 0);
        return false;
    }
    catch (error) {
        // ESRCH: no such process. EPERM: exists but owned by another user.
        return error.code === "ESRCH";
    }
}
/** Build the single replay-safe probe tool with an in-memory call counter. */
export function buildProbeTool(counter) {
    return defineTool({
        name: PROBE_TOOL_NAME,
        description: "Echoes a nonce back to the caller. Call exactly once with the nonce from the user instruction.",
        parameters: Type.Object({
            nonce: Type.String({ description: "The nonce supplied in the instruction." }),
        }),
        replay: "safe",
        async execute(args) {
            counter.calls += 1;
            return {
                output: [{ type: "text", text: `echo:${args.nonce}` }],
            };
        },
    });
}
/** Extension wrapping the single probe tool, installable in a registry. */
export function buildProbeExtension(counter) {
    return defineExtension({
        name: "pi-durable-probe",
        tools: [buildProbeTool(counter)],
    });
}
/** The instruction the probe submits; names the tool and the nonce. */
export function buildInstruction(nonce) {
    return [
        `You must call the tool "${PROBE_TOOL_NAME}" exactly once, passing nonce="${nonce}".`,
        `After the tool returns, reply with the single line: nonce=${nonce}.`,
        "Do not call any other tool. Do not omit the tool call.",
    ].join("\n");
}
/**
 * Open file-backed storage for the probe, ensuring the state directory exists
 * with private (0700) permissions before the store file is created.
 */
async function openProbeStorage(stateDir) {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await chmod(stateDir, 0o700).catch(() => undefined);
    return openNodeSqliteStorage(resolve(stateDir, "probe.sqlite"));
}
/**
 * Run the probe once: open, submit, wait, classify, close, reopen, verify
 * idempotence, and return the JSON-safe result.
 */
export async function runProbe(options, host = {}) {
    const config = await loadProbeConfig(options);
    const resolveCred = host.resolveCredential ?? ((ref) => resolveCredential(ref));
    const credential = await resolveCred(config.credential);
    const stateDir = resolve(config.paths.stateDir);
    // Per-run unique request id; the SAME id and payload are reused when the
    // store is reopened below, so the reopen resolves to the existing submission
    // and triggers no second provider execution.
    const requestId = `${PROBE_REQUEST_ID_PREFIX}-${randomUUID()}`;
    const nonce = host.nonce ?? randomUUID();
    const counter = { calls: 0 };
    const instruction = buildInstruction(nonce);
    const models = () => (host.createModels ?? createModalModels)(config, credential);
    const extension = buildProbeExtension(counter);
    const registry = createRegistry();
    registry.install(extension);
    let lock;
    let storage;
    let reopenedStorage;
    let harness;
    let reopenedHarness;
    let conversationId;
    let submissionId;
    let reopened = false;
    let idempotent = false;
    try {
        await mkdir(stateDir, { recursive: true, mode: 0o700 });
        await chmod(stateDir, 0o700).catch(() => undefined);
        lock = await acquireLock(stateDir);
        storage = await openProbeStorage(stateDir);
        harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
        harness.resume();
        const root = await harness.root(BACKGROUND_CONTEXT, {
            agent: {
                model: { provider: host.providerId ?? configuredProviderId(config), modelId: config.model },
                instructions: `Probe mode. Call ${PROBE_TOOL_NAME} exactly once, then echo the nonce.`,
            },
        });
        conversationId = root.id;
        const submission = await root.submit({
            type: "input",
            requestId,
            content: [{ type: "text", text: instruction }],
        }, BACKGROUND_CONTEXT);
        submissionId = submission.id;
        const settled = await withTimeout(submission.wait(BACKGROUND_CONTEXT), options.timeoutMs, () => root.abort(BACKGROUND_CONTEXT));
        const page = await root.entries({ order: "ascending" }, 1000, undefined, BACKGROUND_CONTEXT);
        const terminal = inspectEntries(page.items, nonce);
        await harness.close(BACKGROUND_CONTEXT);
        harness = undefined;
        await storage.close(BACKGROUND_CONTEXT);
        storage = undefined;
        // Reopen the same store and reacquire the same submission (by id AND by
        // the same requestId) to prove idempotence: the IDs are stable and no new
        // model call was made.
        reopenedStorage = await openProbeStorage(stateDir);
        reopenedHarness = await Harness.open(reopenedStorage, { models, registry }, BACKGROUND_CONTEXT);
        reopenedHarness.resume();
        const reopenedRoot = await reopenedHarness.root(BACKGROUND_CONTEXT);
        reopened = true;
        const reacquired = await reopenedHarness.submission(settled.id, BACKGROUND_CONTEXT);
        const reacquiredByRequest = await reopenedRoot.submit({ type: "input", requestId, content: [{ type: "text", text: instruction }] }, BACKGROUND_CONTEXT);
        const reacquiredRecord = reacquired === undefined ? undefined : await reacquired.status(BACKGROUND_CONTEXT);
        idempotent =
            reacquired !== undefined &&
                reacquired.id === settled.id &&
                reacquiredRecord?.conversationId === root.id &&
                reacquiredByRequest.id === settled.id &&
                counter.calls === 1;
        await reopenedHarness.close(BACKGROUND_CONTEXT);
        reopenedHarness = undefined;
        await reopenedStorage.close(BACKGROUND_CONTEXT);
        reopenedStorage = undefined;
        const stopReason = terminal.stopReason;
        const terminalOk = settled.status === "done" &&
            terminal.toolCalls === 1 &&
            terminal.stopped &&
            terminal.echoedNonce &&
            idempotent;
        const base = {
            ok: terminalOk,
            model: config.model,
            conversationId: conversationId === undefined ? "" : String(conversationId),
            submissionId: submissionId === undefined ? "" : String(submissionId),
            requestId,
            toolCalls: terminal.toolCalls,
            reopened,
            idempotent,
            stopReason,
        };
        if (terminalOk)
            return base;
        return {
            ...base,
            error: `Probe did not complete cleanly (status=${settled.status}, ` +
                `stopReason=${stopReason ?? "none"}, toolCalls=${terminal.toolCalls}, ` +
                `echoedNonce=${terminal.echoedNonce}).`,
        };
    }
    catch (error) {
        return {
            ok: false,
            model: config.model,
            conversationId: conversationId === undefined ? "" : String(conversationId),
            submissionId: submissionId === undefined ? "" : String(submissionId),
            requestId,
            toolCalls: counter.calls,
            reopened,
            idempotent,
            stopReason: null,
            error: redactError(error, [credential.apiKey]).message,
        };
    }
    finally {
        // Release harnesses before storages, then storages, on every path. Each
        // close is itself bounded: a provider that ignores abort could otherwise
        // make `Harness#close` wait on the in-flight run forever and hang the probe.
        await closeQuietly(harness, BACKGROUND_CONTEXT);
        await closeQuietly(reopenedHarness, BACKGROUND_CONTEXT);
        await closeStorageQuietly(storage, BACKGROUND_CONTEXT);
        await closeStorageQuietly(reopenedStorage, BACKGROUND_CONTEXT);
        await lock?.release();
    }
}
/** Bounded grace period for tearing down a harness or storage handle. */
const CLEANUP_TIMEOUT_MS = 2_000;
/** Close a harness without throwing and without waiting indefinitely. */
async function closeQuietly(harness, context) {
    if (harness === undefined)
        return;
    await raceTimeout(harness.close(context), CLEANUP_TIMEOUT_MS);
}
/** Close a storage handle without throwing and without waiting indefinitely. */
async function closeStorageQuietly(storage, context) {
    if (storage === undefined)
        return;
    await raceTimeout(storage.close(context), CLEANUP_TIMEOUT_MS);
}
/** Await `promise`, but give up after `timeoutMs`; never rejects. */
async function raceTimeout(promise, timeoutMs) {
    let timer;
    try {
        await Promise.race([
            promise.catch(() => undefined),
            new Promise((resolveTimer) => {
                timer = setTimeout(resolveTimer, timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
/** Race a promise against a timeout, invoking `onTimeout` once on expiry. */
async function withTimeout(promise, timeoutMs, onTimeout) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    void onTimeout().catch(() => undefined);
                    reject(new ProbeError("timeout", `Probe timed out after ${timeoutMs}ms.`));
                }, timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
/** Safe, key-free summary used by tests and diagnostics. */
export function describeProbeCredential(credential) {
    return redactCredential(credential);
}
/** CLI entry point. Prints one JSON line and returns the process exit code. */
export async function main(argv) {
    let result;
    try {
        const options = parseProbeArgs(argv);
        result = await runProbe(options);
    }
    catch (error) {
        const message = redactError(error).message;
        result = {
            ok: false,
            model: "",
            conversationId: "",
            submissionId: "",
            requestId: "",
            toolCalls: 0,
            reopened: false,
            idempotent: false,
            stopReason: null,
            error: message,
        };
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 1;
}
/** True when this module is the process entry point. */
function isEntryPoint() {
    const entry = process.argv[1];
    if (entry === undefined)
        return false;
    try {
        return resolve(entry) === fileURLToPath(import.meta.url);
    }
    catch {
        return false;
    }
}
if (isEntryPoint()) {
    main(process.argv.slice(2))
        .then((code) => {
        process.exitCode = code;
    })
        .catch(() => {
        process.stdout.write(`${JSON.stringify({
            ok: false,
            model: "",
            conversationId: "",
            submissionId: "",
            requestId: "",
            toolCalls: 0,
            reopened: false,
            idempotent: false,
            stopReason: null,
            error: "Unhandled probe failure.",
        })}\n`);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=probe.js.map