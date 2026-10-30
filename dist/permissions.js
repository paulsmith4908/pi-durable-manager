/** Operator-owned execution policy. Never load authority from the worker checkout. */
import { createHash } from 'node:crypto';
import { resolve, isAbsolute } from 'node:path';
import { StoreError } from './store.js';
const key = (projectId) => `workflow-worker-permissions:${projectId ?? 'default'}`;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function parsePermissions(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new StoreError('invalid_params', 'Expected a permission policy.');
    const p = raw;
    const keys = ['writeFiles', 'shell', 'network', 'hostValidation', 'excludedPaths'];
    if (Object.keys(p).some(k => !keys.includes(k)))
        throw new StoreError('invalid_params', 'Unknown permission.');
    for (const k of keys.slice(0, 4))
        if (typeof p[k] !== 'boolean')
            throw new StoreError('invalid_params', `Expected boolean ${k}.`);
    if (p.shell && !p.writeFiles)
        throw new StoreError('invalid_params', 'Shell requires file writes: arbitrary shell cannot promise read-only project access.');
    if (!Array.isArray(p.excludedPaths) || p.excludedPaths.length > 64)
        throw new StoreError('invalid_params', 'At most 64 excluded project-relative paths.');
    const excludedPaths = [...new Set(p.excludedPaths.map(path => {
            if (typeof path !== 'string' || !path || path.length > 250 || isAbsolute(path) || path.split('/').some(x => !x || x === '.' || x === '..') || /[\\\x00-\x1f*?\[\]]/.test(path)) {
                throw new StoreError('invalid_params', 'Exclusions must be literal project-relative file or directory paths, without wildcards or traversal.');
            }
            return path;
        }))].sort();
    return { writeFiles: p.writeFiles, shell: p.shell, network: p.network, hostValidation: p.hostValidation, excludedPaths };
}
export function effectivePermissions(store, network, projectId) {
    const project = projectId ? store.getControl(key(projectId)) : undefined;
    const defaults = store.getControl(key());
    const policy = parsePermissions(project ?? defaults ?? { writeFiles: true, shell: true, network, hostValidation: true, excludedPaths: [] });
    const source = project ? 'project' : defaults ? 'default' : 'legacy-config';
    return { revision: digest({ policy, source }), source, policy };
}
export function permissionPaths(store, network, projectId) {
    const project = store.getProject(projectId);
    if (!project)
        throw new StoreError('not_found', 'Unknown project.');
    return effectivePermissions(store, network, projectId).policy.excludedPaths.map(p => resolve(project.path, p));
}
export function permissionRefusal(policy, tool) {
    const denied = (!policy.writeFiles && ['write', 'edit'].includes(tool)) || (!policy.shell && tool === 'bash') || (!policy.hostValidation && tool === 'host_validate');
    return denied ? `${tool} is disabled by the operator's permission policy. Ask request_manager; do not work around the restriction. A user-authorized policy change requires settling the current writer first.` : undefined;
}
export const PERMISSION_OPERATIONS = {
    'permissions.read': { params: ['projectId', 'assignmentId'], summary: 'Effective operator-owned permissions and an optional immutable assignment policy snapshot.' },
    'permissions.set': { params: ['projectId', 'policy', 'expectedRevision', 'requestId'], requestId: 'requestId', summary: 'Set default/project permissions with optimistic revision checking; refuses any affected writer lease. Does not modify AGENTS.md.' },
};
export function permissionOperation(store, network, method, p) {
    const projectId = p.projectId;
    if (projectId !== undefined && (typeof projectId !== 'string' || !store.getProject(projectId)))
        throw new StoreError('not_found', 'Unknown project.');
    const current = effectivePermissions(store, network, projectId);
    if (method === 'permissions.read') {
        const assignment = typeof p.assignmentId === 'string' ? store.getAssignment(p.assignmentId) : undefined;
        if (p.assignmentId !== undefined && (!assignment || projectId && assignment.projectId !== projectId))
            throw new StoreError('not_found', 'Unknown assignment for this project.');
        return { ...current, projectId: projectId ?? null, default: effectivePermissions(store, network), assignment: assignment ? store.getControl(`assignment-permissions:${assignment.id}`) ?? null : null,
            boundaries: 'Project checkout only. Secret/manager paths and Git metadata remain protected. Shell plus networking is broad execution authority, not a guarantee against all external actions. Publishing and credential access are not granted by these switches.' };
    }
    if (method !== 'permissions.set')
        throw new StoreError('method_not_found', 'Unknown permission operation.');
    if (typeof p.requestId !== 'string' || !p.requestId || p.requestId.length > 200)
        throw new StoreError('invalid_params', 'Bounded requestId required.');
    const policy = parsePermissions(p.policy);
    return store.withTransaction(() => {
        const j = store.beginJournal(method, p.requestId, { projectId: projectId ?? null, policy, expectedRevision: p.expectedRevision });
        const resultKey = `workflow-permission-result:${p.requestId}`;
        if (j.replayed && j.record.status === 'ready')
            return store.getControl(resultKey);
        if (p.expectedRevision !== current.revision)
            throw new StoreError('conflict', 'Permissions changed; refresh and review before saving.');
        const active = store.listAssignments(projectId).some(a => a.leasePath || ['running', 'queued', 'cancelling'].includes(a.state));
        if (active)
            throw new StoreError('writer_active', 'Stop and join affected work before changing permissions. No running command will be silently reauthorized.');
        store.setPrivateConfiguration(key(projectId), policy);
        const result = effectivePermissions(store, network, projectId);
        store.appendActivity({ kind: 'permissions.changed', projectId: projectId ?? null, assignmentId: null, requestId: p.requestId, dedupKey: `permissions:${p.requestId}`, data: { before: current, after: result, authority: 'operator RPC', affects: projectId ?? 'projects inheriting defaults' } });
        store.setPrivateConfiguration(resultKey, result);
        store.completeJournal(method, p.requestId, String(projectId ?? 'default'));
        return result;
    });
}
//# sourceMappingURL=permissions.js.map