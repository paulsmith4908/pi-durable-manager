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
import type { Extension, HookRegistration, ToolRegistration } from "@earendil-works/pi-durable";
import { ProcessTracker, type ProcessHooks, type ResolvedToolPolicy, type ToolPolicy } from "./sandbox.js";
export type { ToolPolicy, ResolvedToolPolicy, CommandResult, ProcessHooks, } from "./sandbox.js";
export { ToolError, ProcessTracker } from "./sandbox.js";
/** Max bytes returned inline by `read`; larger files spill to an output path. */
export declare const DEFAULT_READ_MAX_BYTES: number;
/** Default extension name prefix; the project id is appended to keep names unique. */
export declare const DEFAULT_EXTENSION_PREFIX = "pi-durable-project";
/** Options accepted by the factory; `root` is the first positional argument. */
export type CreateProjectToolsOptions = Omit<ToolPolicy, "root"> & {
    readonly workingBrief?: (input: {
        conversationId: string;
        callId: string;
        notes: unknown;
        paths: string[];
    }) => Promise<unknown>;
    readonly hostValidate?: (input: {
        conversationId: string;
        callId: string;
        profile: string;
    }) => Promise<{
        state: string;
        [key: string]: unknown;
    }>;
    /** Hooks forwarded to bash process lifecycle events. */
    readonly hooks?: ProcessHooks;
    /** Shared tracker so `abortActiveProcesses` can reach this project's shells. */
    readonly tracker?: ProcessTracker;
    /**
     * Deterministic, UNIQUE extension name for this project. Pi's registry keys
     * extensions by name, so a constant name would make every project's bundle
     * collide (the last registered wins, silently disabling the rest). Callers
     * MUST pass a distinct name per project, e.g. `${DEFAULT_EXTENSION_PREFIX}:${id}`.
     * When omitted, a name is derived from the canonical root path.
     */
    readonly extensionName?: string;
    /** Test seam: run bash without sandbox-exec. Never set in production. */
    readonly unsandboxedForTesting?: boolean;
    /**
     * Generation hooks to register on this project's extension. The engine uses
     * this to enforce per-assignment step/timeout budgets (`beforeRequest`).
     */
    readonly generationHooks?: readonly HookRegistration[];
    /**
     * Tool hooks to register on this project's extension. The engine uses this to
     * install the authoritative `beforeTool` admission guard: every project tool
     * call is refused unless the owning assignment is currently admitted.
     */
    readonly toolGuards?: readonly HookRegistration[];
    /**
     * Trusted, SYNCHRONOUS admission gate run at the top of every tool `execute`,
     * BEFORE any path resolution or side effect. Returns a human-readable reason
     * to REFUSE the call (the tool then makes no filesystem change), or
     * `undefined` to allow it. Throwing also refuses. This is defense-in-depth in
     * front of the `beforeTool` hook so a side effect can never precede the gate.
     */
    readonly beforeExecute?: (context: {
        readonly toolName: string;
        readonly taskId: string;
        readonly conversationId: string;
        readonly callId: string;
    }) => string | undefined;
    /**
     * Trusted handler for the `request_manager` tool. It is bound by the engine to
     * the CURRENT assignment/project/conversation; the model can only ask for
     * help within its own assignment — it can never choose a different thread or
     * project. Returns `{ ok: true, intentId, state: "pausing" }` after the pause
     * INTENT has been durably recorded and the run is being paused (the outbox
     * event is written asynchronously once cleanup is confirmed — so this returns
     * the TRUTHFUL intent id, never a fabricated event id), or `{ ok: false,
     * error }` to surface a bounded diagnostic. When omitted, the tool is NOT
     * registered.
     */
    readonly requestManager?: (params: {
        readonly question: string;
        readonly context: string | null;
        readonly taskId: string;
        readonly conversationId: string;
        readonly callId: string;
    }) => {
        ok: true;
        intentId: string;
        state: "pausing";
    } | {
        ok: false;
        error: string;
    };
};
/** The per-project tool bundle returned by the factory. */
export interface ProjectTools {
    readonly policy: ResolvedToolPolicy;
    readonly extension: Extension;
    readonly tools: readonly ToolRegistration[];
    read: ToolRegistration;
    write: ToolRegistration;
    edit: ToolRegistration;
    bash: ToolRegistration;
    /** Present only when the engine supplied a `requestManager` handler. */
    request_manager?: ToolRegistration;
    /** Kill every live bash process group for this project. */
    abortActiveProcesses(): void;
    /**
     * Kill every live bash process group AND wait (bounded) for each owned child
     * to actually exit. Resolves `true` when all owned groups drained. Used by the
     * manager-pause finalizer to CONFIRM no writer is still flushing before the
     * durable pause is recorded.
     */
    abortActiveProcessesAndDrain(timeoutMs: number): Promise<boolean>;
    /**
     * Kill every owned group AND confirm the registry stays empty across a quiet
     * window (bounded by `timeoutMs`). Use this to make a durable pause truthful:
     * a tool call still spawning its supervisor registers slightly after the
     * first kill, so a single drain can race past it.
     */
    abortActiveProcessesAndDrainStable(timeoutMs: number): Promise<boolean>;
}
/**
 * Create the four coding tools and their extension for one project.
 *
 * `root` is canonicalized once here; every tool closes over the resolved
 * policy, so no model-supplied cwd can widen the boundary.
 */
export declare function createProjectTools(root: string, options?: CreateProjectToolsOptions): Promise<ProjectTools>;
/** Build only the extension for a project (convenience wrapper). */
export declare function createProjectExtension(root: string, options?: CreateProjectToolsOptions): Promise<Extension>;
/** Environment a sandboxed bash sees, exposed for tests and evidence. */
export declare function previewSandboxEnv(policy: ResolvedToolPolicy): Record<string, string>;
//# sourceMappingURL=tools.d.ts.map