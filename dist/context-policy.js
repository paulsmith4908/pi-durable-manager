/** Keep answer capacity; avoid overlapping background/blocking summaries. */
export function workerCompactionPolicy(contextWindow, maxTokens) {
    const reserveTokens = maxTokens + Math.floor(Math.min(2048, (contextWindow - maxTokens) / 4));
    return { enabled: true, reserveTokens,
        keepRecentTokens: Math.max(1, Math.min(20000, Math.floor((contextWindow - reserveTokens) / 4))),
        backgroundTokens: 0 };
}
//# sourceMappingURL=context-policy.js.map