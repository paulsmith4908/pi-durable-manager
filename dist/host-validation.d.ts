import type { MetadataStore, AssignmentRecord } from './store.js';
export type BrowserStep = {
    action: 'goto' | 'click' | 'fill' | 'press' | 'text' | 'count' | 'reload';
    selector?: string;
    value?: string;
    count?: number;
};
export interface ValidationProfile {
    name: string;
    serveDirectory: string;
    steps: BrowserStep[];
}
export interface ValidationResult {
    id: string;
    assignmentId: string;
    profile: string;
    profileHash: string;
    state: 'running' | 'passed' | 'failed' | 'in_doubt';
    at: number;
    finishedAt?: number;
    sourceHash?: string;
    completedSteps: number;
    error?: string;
    consoleErrors?: string[];
    blockedRequests?: number;
    artifacts?: {
        path: string;
        sha256: string;
    }[];
}
export declare const profileKey: (projectId: string, name: string) => string;
export declare function parseProfile(raw: unknown): ValidationProfile;
/** Snapshot public assets before launch; no symlinks, hidden files, or live filesystem serving. */
export declare function snapshotSite(root: string, directory: string, protectedPaths?: readonly string[]): Promise<Map<string, Buffer>>;
export declare function recentValidation(store: MetadataStore, assignmentId: string): ValidationResult[];
export declare function runHostValidation(opts: {
    store: MetadataStore;
    row: AssignmentRecord;
    root: string;
    stateDir: string;
    profileName: string;
    callId: string;
    protectedPaths: readonly string[];
    admitted: () => boolean;
}): Promise<ValidationResult>;
//# sourceMappingURL=host-validation.d.ts.map