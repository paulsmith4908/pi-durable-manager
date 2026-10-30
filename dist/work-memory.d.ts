/** Bounded, observed tool facts. No model-authored summaries or source contents. */
export interface WorkMemory {
    seen: string[];
    reads: {
        path: string;
        hash: string;
        offset: number;
        repeats: number;
    }[];
    edits: string[];
    readsSinceEdit: number;
    lastEditAt: number | null;
    loop: boolean;
}
export declare function rememberTool(previous: WorkMemory | null, id: string, tool: string, args: Record<string, unknown>, result: {
    isError?: boolean;
    details?: unknown;
}, now: number): WorkMemory;
export declare function workMemoryMessage(m: WorkMemory): string;
//# sourceMappingURL=work-memory.d.ts.map