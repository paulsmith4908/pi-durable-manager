import { type MetadataStore, type ManagerEventRecord } from './store.js';
type Params = Record<string, any>;
export interface WorkflowRecord {
    id: string;
    projectId: string;
    threadId: string;
    objective: string;
    roadmap: string;
    state: 'active' | 'stopping' | 'stopped' | 'complete';
    assignments: string[];
    submissions: string[];
    createdAt: number;
    updatedAt: number;
    pause?: {
        assignmentId: string | null;
        requestId: string;
        note: string;
    };
}
export declare const WORKFLOW_OPERATIONS: {
    readonly 'workflow.open': {
        readonly params: readonly ["projectId", "threadId", "objective", "roadmap", "requestId"];
        readonly requestId: "requestId";
        readonly summary: "Opt into one durable project task; reconnect the same owner without duplicating workers.";
    };
    readonly 'workflow.list': {
        readonly params: readonly ["projectId", "threadId"];
        readonly summary: "Compact recoverable task index, newest first.";
    };
    readonly 'workflow.assignments': {
        readonly params: readonly ["id", "before", "limit"];
        readonly summary: "Bounded assignment history, newest first, with stable exclusive submission-index cursor. Read-only.";
    };
    readonly 'workflow.status': {
        readonly params: readonly ["id"];
        readonly summary: "Task roadmap, owned assignments, real latest activity, and wake health.";
    };
    readonly 'workflow.update': {
        readonly params: readonly ["id", "roadmap", "requestId"];
        readonly requestId: "requestId";
        readonly summary: "Persist the manager roadmap and milestone acceptance criteria.";
    };
    readonly 'workflow.submit': {
        readonly params: readonly ["id", "task", "criteria", "parentId", "milestoneId", "profileId", "requestId"];
        readonly requestId: "requestId";
        readonly summary: "Submit one task-owned assignment with a fresh session and unlimited default execution budget.";
    };
    readonly 'workflow.answer': {
        readonly params: readonly ["id", "eventId", "answer", "activityCategory", "requestId"];
        readonly requestId: "requestId";
        readonly summary: "Persist decision, inspect checkpoint, safely release paused worker, submit fresh continuation, then acknowledge.";
    };
    readonly 'workflow.event': {
        readonly params: readonly ["eventId"];
        readonly summary: "Read current event eligibility, decision and task generation before acting on a GUI wake.";
    };
    readonly 'workflow.finish': {
        readonly params: readonly ["id", "note", "requestId"];
        readonly requestId: "requestId";
        readonly summary: "Finish an independently reviewed task and retire its wake binding and events.";
    };
    readonly 'workflow.stop': {
        readonly params: readonly ["id", "note", "requestId"];
        readonly requestId: "requestId";
        readonly summary: "Durably stop only this task, join its workers, retire notifications. Safe to retry after disconnect.";
    };
    readonly 'workflow.review': {
        readonly params: readonly ["id", "eventId", "decision", "note", "evidenceHash", "requestId"];
        readonly requestId: "requestId";
        readonly summary: "Record an explicit review against inspected evidence, verify acceptance freshness, apply verdict, then acknowledge. Does not review on behalf of the caller.";
    };
    readonly 'workflow.handoff': {
        readonly params: readonly ["id", "expectedThreadId", "threadId", "note", "requestId"];
        readonly requestId: "requestId";
        readonly summary: "Transfer a safely paused or settled task to an explicitly selected existing chat; retire old wakes and reissue unresolved attention.";
    };
    readonly 'workflow.pause': {
        readonly params: readonly ["id", "note", "requestId"];
        readonly requestId: "requestId";
        readonly summary: "Fence new work immediately, let admitted tools finish, retain the lease and report safe pause asynchronously. No execution deadline.";
    };
    readonly 'workflow.resume': {
        readonly params: readonly ["id", "summary", "requestId"];
        readonly requestId: "requestId";
        readonly summary: "Verify a confirmed operator pause, preserve a continuation packet, join old work and admit one fresh session. Never replays quarantined commands.";
    };
};
export declare function projectWorkflow(store: MetadataStore, projectId: string): WorkflowRecord | null;
export declare function workflowOwns(store: MetadataStore, task: WorkflowRecord, assignmentId: string): boolean;
/** A retired generation must not wake, even if old queue messages arrive later. */
export declare function workflowEventScope(store: MetadataStore, event: Pick<ManagerEventRecord, 'projectId' | 'assignmentId'> & {
    threadId?: string | null;
}): {
    workflowId: string | null;
    actionable: boolean;
};
export declare class WorkflowService {
    private store;
    private call;
    private changed;
    private tail;
    constructor(store: MetadataStore, call: (method: string, params: Params) => Promise<any>, changed?: () => void);
    run(method: string, p: Params): Promise<any>;
    private task;
    private save;
    private active;
    private rows;
    private execute;
    private pause;
    private resume;
    private review;
    private handoff;
    private open;
    private submit;
    private answer;
}
export {};
//# sourceMappingURL=workflow.d.ts.map