export declare function guardDecision(input: {
    healthy: boolean;
    paused: boolean;
    owner: "alive" | "dead" | "unknown";
}): "healthy" | "paused" | "hold" | "start";
/** Separate code-only process: detects daemon failure even when its in-process timers are gone. */
export declare function runRuntimeGuard(options: {
    configPath: string;
    binPath: string;
    threadId: string;
    signal: AbortSignal;
    intervalMs?: number;
    alertAfterMs?: number;
}): Promise<void>;
//# sourceMappingURL=runtime-guard.d.ts.map