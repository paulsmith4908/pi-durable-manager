import type { CompactionPolicy } from "@earendil-works/pi-durable";

/** Keep answer capacity; avoid overlapping background/blocking summaries. */
export function workerCompactionPolicy(contextWindow: number, maxTokens: number): CompactionPolicy {
  const reserveTokens = maxTokens + Math.floor(Math.min(2048, (contextWindow - maxTokens) / 4));
  return { enabled: true, reserveTokens,
    keepRecentTokens: Math.max(1, Math.min(20000, Math.floor((contextWindow - reserveTokens) / 4))),
    backgroundTokens: 0 };
}
