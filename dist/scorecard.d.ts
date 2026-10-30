/** Manager-owned accounting. Counts are observations, never inferred productivity. */
import { type MetadataStore, type AssignmentRecord } from './store.js';
import type { WorkflowRecord } from './workflow.js';
type Params = Record<string, any>;
export declare const CATEGORIES: readonly ["planning", "review", "product_decision", "debugging_guidance", "implementation", "repair", "revision_guidance", "question_unclassified", "steering_unclassified", "recovery"];
type Category = typeof CATEGORIES[number];
export declare const SCORECARD_OPERATIONS: {
    readonly 'scorecard.read': {
        readonly params: readonly ["id"];
        readonly summary: "Read evidence-based assignment counts, prospective scope, manager ledger and milestone trends. No model calls.";
    };
    readonly 'scorecard.ledger': {
        readonly params: readonly ["id", "before", "limit"];
        readonly summary: "Page the durable manager ledger newest first; before is the exclusive index cursor.";
    };
    readonly 'scorecard.plan': {
        readonly params: readonly ["id", "milestoneId", "title", "points", "requestId"];
        readonly requestId: "requestId";
        readonly summary: "Append an immutable prospective milestone weight before its work begins.";
    };
    readonly 'scorecard.activity': {
        readonly params: readonly ["id", "milestoneId", "assignmentId", "category", "note", "activeSeconds", "retrospective", "requestId"];
        readonly requestId: "requestId";
        readonly summary: "Append one idempotent Codex work entry. Unknown effort stays null; retrospective reports are labelled.";
    };
    readonly 'scorecard.accept': {
        readonly params: readonly ["id", "milestoneId", "owner", "assignmentId", "note", "evidence", "requestId"];
        readonly requestId: "requestId";
        readonly summary: "Record independently reviewed milestone completion and attribution; Pi/mixed requires an accepted linked assignment.";
    };
};
/** Called before submission side effects; children inherit their parent's milestone. */
export declare function checkMilestone(s: MetadataStore, t: WorkflowRecord, p: Params): void;
export declare function linkMilestone(s: MetadataStore, t: WorkflowRecord, p: Params, assignment: AssignmentRecord): void;
export declare function activityCategory(p: Params, fallback: Category): Category;
export declare function recordWorkflowActivity(s: MetadataStore, t: WorkflowRecord, eventId: string, category: Category, note: string, assignmentId: string): void;
export declare function scorecardOperation(s: MetadataStore, method: string, p: Params): any;
export declare function readScorecard(s: MetadataStore, t: WorkflowRecord): any;
export {};
//# sourceMappingURL=scorecard.d.ts.map