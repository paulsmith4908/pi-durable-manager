/**
 * Sandboxed coding tools for a single project.
 *
 * `createProjectTools(root, options)` builds `read`, `write`, `edit`, and
 * `bash` tools bound to one canonical project root. `createProjectExtension`
 * wraps them in a Pi `Extension` so the assignment engine can register it per
 * project and enable only the owning extension on a session.
 *
 * All path arguments are resolved inside the root by a per-project closure; the
 * model never supplies a working directory. Every failure is returned to the
 * model as an error result (isError + diagnostic) rather than thrown, so a bad
 * call never crashes the service.
 */
import { mkdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { readPage, READ_PAGE_BYTES } from "./read-page.js";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { ToolError, ProcessTracker, buildSandboxEnv, lstatOrUndefined, readFileNoFollow, resolvePolicy, resolveWithinRoot, runSandboxedCommand, writeFileNoFollow, } from "./sandbox.js";
export { ToolError, ProcessTracker } from "./sandbox.js";
/** Max bytes returned inline by `read`; larger files spill to an output path. */
export const DEFAULT_READ_MAX_BYTES = READ_PAGE_BYTES;
/** Default extension name prefix; the project id is appended to keep names unique. */
export const DEFAULT_EXTENSION_PREFIX = "pi-durable-project";
/**
 * Largest delay Node's `setTimeout` can represent. An explicit worker bash
 * timeout above this would silently overflow to ~1ms, so it is rejected.
 */
const MAX_TIMER_MS = 2_147_483_647;
/** Build a model-visible error result from a ToolError (or unknown). */
function errorResult(code, message, details) {
    const diagnostic = {
        severity: "error",
        message,
        code,
    };
    const suffix = details ? ` ${JSON.stringify(details)}` : "";
    return {
        output: [{ type: "text", text: `error: ${message}${suffix}` }],
        isError: true,
        diagnostics: [diagnostic],
    };
}
/** Convert a thrown value into a structured error result. */
function caught(error) {
    if (error instanceof ToolError) {
        return errorResult(error.code, error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    return errorResult("spawn_error", message);
}
/**
 * Refusal result for a tool call the admission gate rejected. Fail-closed: the
 * caller MUST invoke this BEFORE resolving a path or touching the filesystem.
 */
function refused(toolName, reason) {
    return errorResult("not_owner", `refused: ${toolName} blocked by admission gate (${reason})`);
}
/** Resolve a path argument within the project boundary. */
async function boundary(policy, inputPath, mode) {
    return resolveWithinRoot(policy, inputPath, mode);
}
/**
 * Create the four coding tools and their extension for one project.
 *
 * `root` is canonicalized once here; every tool closes over the resolved
 * policy, so no model-supplied cwd can widen the boundary.
 */
export async function createProjectTools(root, options = {}) {
    if (!(await directoryExists(root))) {
        throw new ToolError("not_found", `project root does not exist: ${root}`);
    }
    const canonicalRoot = await realpath(root);
    const policy = resolvePolicy({ ...options, root: canonicalRoot });
    const tracker = options.tracker ?? new ProcessTracker();
    const hooks = options.hooks;
    const beforeExecute = options.beforeExecute;
    /**
     * Run the trusted admission gate, failing closed. Returns a refusal result the
     * caller MUST return (making no side effect) when the call is not admitted.
     */
    const admit = (toolName, api) => {
        if (beforeExecute === undefined)
            return undefined;
        try {
            const reason = beforeExecute({
                toolName,
                taskId: String(api.taskId),
                conversationId: String(api.conversationId),
                callId: api.callId,
            });
            return reason === undefined ? undefined : refused(toolName, reason);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return refused(toolName, message);
        }
    };
    const read = defineTool({
        name: "read",
        description: "Read project text in bounded pages (default 200 lines, at most 12KiB). Prefer targeted offset/limit. Continue with nextByteOffset and expectedHash from the result; never assume a truncated page is the entire file.",
        parameters: Type.Object({
            path: Type.String({ description: "Project-relative file path." }),
            offset: Type.Optional(Type.Number({ description: "0-based line offset." })),
            limit: Type.Optional(Type.Number({ description: "Maximum number of lines." })),
            byteOffset: Type.Optional(Type.Number({ description: "Exact byte cursor returned by a previous page; overrides line offset." })),
            expectedHash: Type.Optional(Type.String({ description: "Previous sourceHash; refuses mixed-version pages if the file changed." })),
        }),
        replay: "safe",
        async execute(args, api, _context) {
            const denial = admit("read", api);
            if (denial !== undefined)
                return denial;
            try {
                const abs = await boundary(policy, args.path, "read");
                const info = await lstatOrUndefined(abs);
                if (info === undefined)
                    throw new ToolError("not_found", `no such file: ${args.path}`);
                if (info.isDirectory())
                    throw new ToolError("is_directory", `is a directory: ${args.path}`);
                const bytes = await readFileNoFollow(abs, 8 * 1024 * 1024);
                const { path: _path, ...range } = args;
                const page = readPage(bytes, range);
                const notice = page.nextByteOffset === null ? "" :
                    `\n[More file content: read path=${JSON.stringify(args.path)} byteOffset=${page.nextByteOffset} expectedHash=${page.sourceHash}. Use a targeted range when possible.]`;
                return { output: [{ type: "text", text: page.text }, ...(notice ? [{ type: "text", text: notice }] : [])],
                    details: { path: args.path, sourceHash: page.sourceHash, byteOffset: page.byteOffset, nextByteOffset: page.nextByteOffset, totalBytes: page.totalBytes, returnedBytes: page.returnedBytes, totalLines: page.totalLines, spilledTo: null } };
            }
            catch (error) {
                return caught(error);
            }
        },
    });
    const write = defineTool({
        name: "write",
        description: "Write text to a file within the project, creating parent directories. Refuses protected paths and symlinked targets.",
        parameters: Type.Object({
            path: Type.String({ description: "Project-relative file path." }),
            content: Type.String({ description: "Full file content." }),
        }),
        replay: "unsafe",
        async execute(args, api, _context) {
            const denial = admit("write", api);
            if (denial !== undefined)
                return denial;
            try {
                const abs = await boundary(policy, args.path, "write");
                const info = await lstatOrUndefined(abs);
                if (info?.isSymbolicLink()) {
                    throw new ToolError("protected_path", `refusing to write through symlink: ${args.path}`);
                }
                if (info?.isDirectory())
                    throw new ToolError("is_directory", `is a directory: ${args.path}`);
                await mkdir(dirname(abs), { recursive: true });
                // Revalidate the canonical path after creating parents: a symlink cannot
                // be introduced into an ancestor between boundary() and the open, but if
                // one appears the re-resolution rejects it. The final open also uses
                // O_NOFOLLOW via writeFileNoFollow so the last component is never
                // followed.
                const rechecked = await boundary(policy, args.path, "write");
                if (rechecked !== abs) {
                    throw new ToolError("outside_root", `path changed during write: ${args.path}`);
                }
                await writeFileNoFollow(abs, args.content);
                return {
                    output: [{ type: "text", text: `wrote ${Buffer.byteLength(args.content, "utf8")} bytes to ${args.path}` }],
                    details: { path: args.path, bytes: Buffer.byteLength(args.content, "utf8") },
                };
            }
            catch (error) {
                return caught(error);
            }
        },
    });
    const edit = defineTool({
        name: "edit",
        description: "Replace exact oldText with newText in a file within the project. Fails when the match is missing or ambiguous unless replaceAll is true.",
        parameters: Type.Object({
            path: Type.String({ description: "Project-relative file path." }),
            oldText: Type.String({ description: "Exact text to find." }),
            newText: Type.String({ description: "Replacement text." }),
            replaceAll: Type.Optional(Type.Boolean({ description: "Replace every occurrence instead of requiring a unique match." })),
        }),
        replay: "unsafe",
        async execute(args, api, _context) {
            const denial = admit("edit", api);
            if (denial !== undefined)
                return denial;
            try {
                if (args.oldText.length === 0) {
                    throw new ToolError("invalid_argument", "oldText must not be empty");
                }
                const abs = await boundary(policy, args.path, "write");
                const info = await lstatOrUndefined(abs);
                if (info === undefined)
                    throw new ToolError("not_found", `no such file: ${args.path}`);
                if (info.isSymbolicLink()) {
                    throw new ToolError("protected_path", `refusing to edit through symlink: ${args.path}`);
                }
                const bytes = await readFileNoFollow(abs, 8 * 1024 * 1024);
                const text = bytes.toString("utf8");
                const occurrences = countOccurrences(text, args.oldText);
                if (occurrences === 0) {
                    throw new ToolError("no_match", `oldText not found in ${args.path}`);
                }
                if (occurrences > 1 && args.replaceAll !== true) {
                    throw new ToolError("ambiguous_match", `oldText matches ${occurrences} times in ${args.path}; pass replaceAll:true or a more specific oldText`);
                }
                const next = args.replaceAll === true
                    ? text.split(args.oldText).join(args.newText)
                    : text.replace(args.oldText, args.newText);
                // Atomic replace: write a sibling temp file then rename over the target.
                const tmp = join(dirname(abs), `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
                await writeFile(tmp, next, { encoding: "utf8", mode: 0o600 });
                await rename(tmp, abs);
                return {
                    output: [{ type: "text", text: `edited ${args.path} (${occurrences} replacement${occurrences === 1 ? "" : "s"})` }],
                    details: { path: args.path, replacements: occurrences },
                };
            }
            catch (error) {
                return caught(error);
            }
        },
    });
    const bash = defineTool({
        name: "bash",
        description: "Run a shell command in the project through a macOS sandbox. Writes are confined to the project and scratch; network is off unless enabled by the operator.",
        parameters: Type.Object({
            command: Type.String({ description: "Shell command line." }),
            timeout: Type.Optional(Type.Number({
                description: "Optional per-command timeout in milliseconds. Nullable/unlimited by default; a shorter explicit value is respected, and when the manager configured a finite cap this value is clamped to it.",
            })),
        }),
        replay: "unsafe",
        async execute(args, api, _context) {
            const denial = admit("bash", api);
            if (denial !== undefined)
                return denial;
            let result;
            try {
                // Per-call timeout resolution. A worker MAY request a positive finite
                // timeout; it is ALWAYS clamped to a finite manager cap, and when the
                // cap is unlimited (null) the explicit value is respected as-is. A
                // non-positive/non-finite request is rejected rather than silently
                // treated as unlimited.
                let perCall = policy;
                if (args.timeout !== undefined) {
                    if (typeof args.timeout !== "number" ||
                        !Number.isFinite(args.timeout) ||
                        args.timeout <= 0 ||
                        args.timeout > MAX_TIMER_MS) {
                        return errorResult("invalid_argument", `bash timeout must be a positive finite number of milliseconds no greater than ${MAX_TIMER_MS}.`);
                    }
                    const cap = policy.timeoutMs;
                    const effective = cap === null ? args.timeout : Math.min(args.timeout, cap);
                    perCall = resolvePolicy({ ...policy, timeoutMs: effective });
                }
                result = await runSandboxedCommand(perCall, args.command, {
                    cwd: perCall.root,
                    hooks,
                    tracker,
                    ...(options.unsandboxedForTesting !== undefined
                        ? { unsandboxedForTesting: options.unsandboxedForTesting }
                        : {}),
                });
            }
            catch (error) {
                return caught(error);
            }
            // `runSandboxedCommand` calls `onCommand` exactly once (including nonzero
            // exit, timeout, and abort), so the tool must not call it again.
            const combined = [result.stdout, result.stderr].filter((s) => s.length > 0).join("\n");
            const text = combined.length > 0 ? combined : "(no output)";
            if (result.exitCode !== 0) {
                // Model-visible error so the model can debug; never aborts the assignment.
                return {
                    output: [
                        {
                            type: "text",
                            text: `exit ${result.exitCode}\n${text}`,
                        },
                    ],
                    isError: true,
                    diagnostics: [
                        { severity: "error", message: `command exited ${result.exitCode}`, code: "nonzero_exit" },
                    ],
                    details: {
                        command: result.command,
                        exitCode: result.exitCode,
                        durationMs: result.durationMs,
                        truncated: result.truncated,
                        totalBytes: result.totalBytes,
                        fullOutputPath: result.fullOutputPath,
                    },
                };
            }
            return {
                output: [{ type: "text", text }],
                details: {
                    command: result.command,
                    exitCode: result.exitCode,
                    durationMs: result.durationMs,
                    truncated: result.truncated,
                    totalBytes: result.totalBytes,
                    fullOutputPath: result.fullOutputPath,
                },
            };
        },
    });
    const tools = [read, write, edit, bash];
    // `request_manager`: the worker's ONLY way to reach a human/manager. Its
    // trusted handler is bound by the engine to the CURRENT assignment — the model
    // cannot redirect the question to another thread or project. A successful call
    // records a durable manager event and pauses the run; the model must then
    // STOP (no further tool calls or generation).
    if (options.workingBrief)
        tools.push(defineTool({
            name: "working_brief",
            description: "Persist a concise working brief across compaction and explicit continuations. Update after meaningful findings, fixes or failed tests, and before requesting manager help. Notes are not proof; files get observed hashes. Never copy full source/logs. Current assignment overrides inherited notes.",
            parameters: Type.Object({ objective: Type.String(), decisions: Type.Array(Type.String()), completed: Type.Array(Type.String()), issues: Type.Array(Type.String()), nextStep: Type.String(), paths: Type.Array(Type.String()) }),
            replay: "safe",
            async execute(args, api) {
                const denial = admit("working_brief", api);
                if (denial)
                    return denial;
                try {
                    const { paths, ...notes } = args;
                    const result = await options.workingBrief({ conversationId: String(api.conversationId), callId: String(api.taskId), notes, paths });
                    return { output: [{ type: "text", text: JSON.stringify(result) }] };
                }
                catch (e) {
                    return caught(e);
                }
            },
        }));
    if (options.hostValidate)
        tools.push(defineTool({
            name: "host_validate",
            description: "Run a manager-configured browser profile against an immutable snapshot of the built static site in isolated host Chrome. No host shell or arbitrary JavaScript. Fix reported failures and run again with a new call; do not ask the manager to run available checks. Results are observed evidence, not acceptance.",
            parameters: Type.Object({ profile: Type.String() }), replay: "unsafe",
            async execute(args, api) {
                const denial = admit("host_validate", api);
                if (denial)
                    return denial;
                try {
                    const result = await options.hostValidate({ conversationId: String(api.conversationId), callId: String(api.taskId), profile: args.profile });
                    return { isError: result.state !== "passed", output: [{ type: "text", text: JSON.stringify(result) }] };
                }
                catch (e) {
                    return caught(e);
                }
            },
        }));
    const requestManager = options.requestManager;
    if (requestManager !== undefined) {
        const ask = defineTool({
            name: "request_manager",
            description: "Ask the project manager for help when you are genuinely blocked and cannot proceed safely. " +
                "This pauses your work and escalates a question to the manager. Do NOT guess or loop; ask. " +
                "After calling this, STOP — make no further tool calls and do not continue generating.",
            parameters: Type.Object({
                question: Type.String({ description: "The specific question or decision you need from the manager." }),
                context: Type.Optional(Type.String({ description: "Optional bounded context: what you tried, exact evidence, and why you are blocked." })),
            }),
            replay: "safe",
            async execute(args, api, _context) {
                const denial = admit("request_manager", api);
                if (denial !== undefined)
                    return denial;
                try {
                    const question = String(args.question ?? "").trim();
                    if (question === "")
                        throw new ToolError("invalid_argument", "question must be a non-empty string");
                    const context = args.context === undefined ? null : String(args.context);
                    const result = requestManager({
                        question,
                        context,
                        taskId: String(api.taskId),
                        conversationId: String(api.conversationId),
                        callId: api.callId,
                    });
                    if (!result.ok) {
                        api.diagnostic({ severity: "error", message: result.error, code: "manager_unavailable" });
                        return {
                            isError: true,
                            output: [{ type: "text", text: `request_manager failed: ${result.error}` }],
                            details: { intentId: null, state: null, error: result.error, paused: false },
                        };
                    }
                    return {
                        output: [
                            {
                                type: "text",
                                text: `Manager request recorded (intent ${result.intentId}, state: ${result.state}). Your work is paused for manager review. ` +
                                    "STOP now: make no further tool calls and do not continue.",
                            },
                        ],
                        details: { intentId: result.intentId, state: result.state, error: null, paused: true },
                    };
                }
                catch (error) {
                    return caught(error);
                }
            },
        });
        tools.push(ask);
        return finishTools(tools, ask);
    }
    return finishTools(tools, undefined);
    function finishTools(list, ask) {
        // A UNIQUE extension name per project is mandatory: the registry is keyed by
        // name, so a shared constant would silently shadow every other project's
        // tools once more than one project is registered.
        const extensionName = options.extensionName ?? `${DEFAULT_EXTENSION_PREFIX}:${canonicalRoot}`;
        const extension = defineExtension({
            name: extensionName,
            tools: list,
            ...(options.generationHooks !== undefined && options.generationHooks.length > 0
                ? { hooks: [...options.generationHooks, ...(options.toolGuards ?? [])] }
                : options.toolGuards !== undefined && options.toolGuards.length > 0
                    ? { hooks: options.toolGuards }
                    : {}),
        });
        return {
            policy,
            extension,
            tools: list,
            read,
            write,
            edit,
            bash,
            ...(ask !== undefined ? { request_manager: ask } : {}),
            abortActiveProcesses: () => tracker.killAll(),
            abortActiveProcessesAndDrain: (timeoutMs) => tracker.killAllAndDrain(timeoutMs),
            abortActiveProcessesAndDrainStable: (timeoutMs) => tracker.killAllAndDrainStable(timeoutMs),
        };
    }
}
/** Build only the extension for a project (convenience wrapper). */
export async function createProjectExtension(root, options = {}) {
    const bundle = await createProjectTools(root, options);
    return bundle.extension;
}
/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack, needle) {
    if (needle.length === 0)
        return 0;
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
        count += 1;
        index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
}
/** True when `path` exists and is a directory. */
async function directoryExists(path) {
    try {
        const info = await stat(path);
        return info.isDirectory();
    }
    catch {
        return false;
    }
}
/** Environment a sandboxed bash sees, exposed for tests and evidence. */
export function previewSandboxEnv(policy) {
    return buildSandboxEnv(policy);
}
//# sourceMappingURL=tools.js.map