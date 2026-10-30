import { type MetadataStore } from './store.js';
export interface WorkerPermissions {
    writeFiles: boolean;
    shell: boolean;
    network: boolean;
    hostValidation: boolean;
    excludedPaths: string[];
}
export interface PermissionSnapshot {
    revision: string;
    source: 'legacy-config' | 'default' | 'project';
    policy: WorkerPermissions;
}
export declare function parsePermissions(raw: unknown): WorkerPermissions;
export declare function effectivePermissions(store: MetadataStore, network: boolean, projectId?: string): PermissionSnapshot;
export declare function permissionPaths(store: MetadataStore, network: boolean, projectId: string): string[];
export declare function permissionRefusal(policy: WorkerPermissions, tool: string): string | undefined;
export declare const PERMISSION_OPERATIONS: {
    readonly 'permissions.read': {
        readonly params: readonly ["projectId", "assignmentId"];
        readonly summary: "Effective operator-owned permissions and an optional immutable assignment policy snapshot.";
    };
    readonly 'permissions.set': {
        readonly params: readonly ["projectId", "policy", "expectedRevision", "requestId"];
        readonly requestId: "requestId";
        readonly summary: "Set default/project permissions with optimistic revision checking; refuses any affected writer lease. Does not modify AGENTS.md.";
    };
};
export declare function permissionOperation(store: MetadataStore, network: boolean, method: string, p: Record<string, unknown>): unknown;
//# sourceMappingURL=permissions.d.ts.map