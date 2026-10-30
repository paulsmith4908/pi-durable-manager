import { type KnownSecrets } from "./redact.js";
export interface ActivityEntry {
    seq: number;
    at: number;
    kind: string;
    projectId: string | null;
    assignmentId: string | null;
    requestId: string | null;
    dedupKey: string | null;
    data: unknown;
}
export type ActivityInput = Omit<ActivityEntry, "seq" | "at"> & {
    at?: number;
};
/** Only emitted text/tool data is recorded. Hidden model reasoning is never a log source. */
export declare function sanitizeActivity(value: unknown, secrets?: KnownSecrets, depth?: number): unknown;
export declare function formatActivity(entry: ActivityEntry): string;
//# sourceMappingURL=activity.d.ts.map