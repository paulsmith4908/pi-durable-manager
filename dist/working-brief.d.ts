import type { MetadataStore, AssignmentRecord } from './store.js';
export interface WorkingBrief {
    assignmentId: string;
    updatedAt: number;
    notes: {
        objective: string;
        decisions: string[];
        completed: string[];
        issues: string[];
        nextStep: string;
    };
    files: {
        path: string;
        sha256: string;
    }[];
}
export declare function briefNotes(raw: unknown): WorkingBrief['notes'];
export declare function briefFiles(root: string, paths: string[], protectedPaths?: readonly string[]): Promise<WorkingBrief['files']>;
/** Only inherit within the same project and explicit parent lineage. */
export declare function findWorkingBrief(store: MetadataStore, row: AssignmentRecord): WorkingBrief | null;
export declare function briefView(store: MetadataStore, row: AssignmentRecord, root: string, protectedPaths?: readonly string[]): Promise<unknown>;
//# sourceMappingURL=working-brief.d.ts.map