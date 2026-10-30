/** Read-only projections of durable facts. Roadmap checkboxes are owned by Codex. */
import { type ObserverRpc } from './native-terminal.js';
import type { ActivityEntry } from './activity.js';
type Row = Record<string, any>;
export declare function roadmapMilestones(roadmap: string): {
    title: string;
    status: string;
}[];
export declare function activitySummary(entry: ActivityEntry): string | null;
/** Deterministic wording of recorded events; no model-generated progress claims. */
export declare function plainWork(entry: ActivityEntry): string | null;
/** Color describes the recorded event, never an inferred claim in worker prose. */
export declare function plainWorkTone(entry: ActivityEntry): string;
export declare function readTerminalOverview(rpc: ObserverRpc, workflowId?: string | null, assignmentId?: string | null): Promise<Row>;
export {};
//# sourceMappingURL=terminal-overview.d.ts.map