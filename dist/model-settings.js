import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { createModels, createProvider, Type } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { validateEndpoint, validateCompat } from './config.js';
import { resolveCredential } from './credential.js';
import { MetadataStore, StoreError } from './store.js';
import { workerCompactionPolicy } from './context-policy.js';
export const MODEL_OPERATIONS = {
    'models.settings': { params: ['projectId'], summary: 'Saved connections, profiles, default and project choice. No credentials returned.' },
    'models.connection.add': { params: ['name', 'endpoint', 'apiKey', 'noAuth', 'allowInsecureHttp', 'requestId'], requestId: 'requestId', summary: 'Add an immutable connection. Enter keys only in the private Settings page.' },
    'models.connection.rotate': { params: ['connectionId', 'apiKey', 'noAuth', 'requestId'], requestId: 'requestId', summary: 'Rotate an added connection credential while no assigned work using it holds a lease. Key input belongs only in private Settings.' },
    'models.connection.disable': { params: ['connectionId', 'requestId'], requestId: 'requestId', summary: 'Revoke an added connection for future work and remove its owned private credential; no silent fallback.' },
    'models.connection.rename': { params: ['connectionId', 'name', 'requestId'], requestId: 'requestId', summary: 'Rename a saved connection without changing execution settings.' },
    'models.profile.add': { params: ['connectionId', 'name', 'model', 'contextWindow', 'maxTokens', 'reasoning', 'compat', 'requestId'], requestId: 'requestId', summary: 'Add an immutable OpenAI-compatible model profile with explicit limits.' },
    'models.default': { params: ['profileId', 'requestId'], requestId: 'requestId', summary: 'Choose the default for new projects only.' },
    'models.project': { params: ['projectId', 'profileId', 'requestId'], requestId: 'requestId', summary: 'Choose a project model while no assignment is active; no automatic fallback.' },
    'models.discover': { params: ['connectionId'], summary: 'Discover advertised models; manual model IDs remain supported.' },
    'models.test': { params: ['profileId'], summary: 'Run a bounded streaming tool-call and tool-result round trip. No project files or tools executed.' },
};
const KEY = 'workflow-model-catalog';
const GENERIC = { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: false, supportsStrictMode: false, maxTokensField: 'max_tokens' };
function text(p, k, max = 200) { if (typeof p[k] !== 'string' || !p[k].trim() || p[k].length > max || /[\x00-\x1f]/.test(p[k]))
    throw new StoreError('invalid_params', `Invalid ${k}`); return p[k].trim(); }
export function connectionEndpoint(value, allowInsecureHttp = false) {
    let u;
    try {
        u = new URL(value);
    }
    catch {
        throw new StoreError('invalid_params', 'Invalid endpoint URL');
    }
    if (u.username || u.password || u.search || u.hash || !['http:', 'https:'].includes(u.protocol))
        throw new StoreError('invalid_params', 'Use an HTTP(S) base URL without credentials, query or fragment');
    if (!allowInsecureHttp)
        validateEndpoint(value);
    return u.toString().replace(/\/+$/, '');
}
/** Immutable profiles pin session semantics. No credential bytes enter metadata, journals or responses. */
export class ModelSettings {
    store;
    config;
    legacyModels;
    legacyProvider;
    secrets;
    compaction = {};
    credentials = new Map();
    extra = createModels();
    pending = new Map();
    mutationTail = Promise.resolve();
    constructor(store, config, legacyModels, legacyProvider, secrets) {
        this.store = store;
        this.config = config;
        this.legacyModels = legacyModels;
        this.legacyProvider = legacyProvider;
        this.secrets = secrets;
        if (!store.getControl(KEY)) {
            const c = { connections: [{ id: 'existing', name: 'Existing connection', endpoint: config.endpoint, credential: config.credential, noAuth: config.credential.none === true, allowInsecureHttp: config.allowInsecureHttp === true, legacy: true }], profiles: [{ id: 'existing', connectionId: 'existing', name: config.model, model: config.model, contextWindow: config.limits.contextWindow, maxTokens: config.limits.maxTokens, reasoning: config.reasoning ?? true, compat: config.compat ?? {}, legacy: true }], defaultProfileId: 'existing' };
            store.setPrivateConfiguration(KEY, c);
            // Historical projects retain the existing endpoint, even before their next session.
            for (const project of store.listProjects())
                store.setPrivateConfiguration(`workflow-model-project:${project.id}`, 'existing');
        }
    }
    catalog() { return this.store.getControl(KEY); }
    profile(id) { const p = this.catalog().profiles.find(p => p.id === id); if (!p)
        throw new StoreError('not_found', 'Model profile not found'); return p; }
    connection(id) { const c = this.catalog().connections.find(c => c.id === id); if (!c)
        throw new StoreError('not_found', 'Connection not found'); return c; }
    async initialize() { await this.cleanCredentials(); for (const c of this.catalog().connections)
        if (!c.legacy && !c.disabled) {
            try {
                await this.loadCredential(c);
            }
            catch { /* One unavailable added credential must not break the legacy service. Selection fails closed. */ }
        } for (const p of this.catalog().profiles)
        this.register(p); }
    async loadCredential(c) { const cred = await resolveCredential(c.credential); this.credentials.set(c.id, cred); if (!c.noAuth)
        this.secrets.push(cred.apiKey); return cred; }
    register(p) {
        const ref = this.ref(p.id);
        this.compaction[`${ref.provider}/${ref.modelId}`] = workerCompactionPolicy(p.contextWindow, p.maxTokens);
        if (p.legacy)
            return;
        const c = this.connection(p.connectionId);
        if (c.disabled)
            return;
        this.extra.setProvider(createProvider({ id: ref.provider, name: p.name, baseUrl: c.endpoint, auth: { apiKey: { name: "Connection API key", resolve: async () => { const cred = this.credentials.get(c.id); if (!cred)
                        throw new Error('Connection credential unavailable; repair connection before using this profile'); return { auth: { apiKey: cred.apiKey }, source: 'private connection' }; } } }, models: [{ id: p.model, name: p.name, provider: ref.provider, api: 'openai-completions', baseUrl: c.endpoint, reasoning: p.reasoning, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: p.contextWindow, maxTokens: p.maxTokens, compat: p.compat }], api: openAICompletionsApi() }));
    }
    models() { const m = createModels(); for (const p of this.legacyModels().getProviders())
        m.setProvider(p); for (const p of this.extra.getProviders()) {
        const profile = this.catalog().profiles.find(x => 'profile-' + x.id === p.id);
        if (profile && !this.connection(profile.connectionId).disabled)
            m.setProvider(p);
    } return m; }
    ref(id) { const p = this.profile(id); return { provider: p.legacy ? this.legacyProvider : `profile-${p.id}`, modelId: p.model }; }
    projectChoice(projectId) { if (!this.store.getProject(projectId))
        throw new StoreError('not_found', 'Project not found'); return this.store.getControl(`workflow-model-project:${projectId}`) ?? this.catalog().defaultProfileId; }
    pin(projectId, requested) { const id = requested ?? this.projectChoice(projectId); this.assertEnabled(this.profile(id).connectionId); this.store.setPrivateConfiguration(`workflow-model-project:${projectId}`, id); return id; }
    historicalRef(sessionId) { return this.ref(this.store.getControl(`workflow-model-session:${sessionId}`) ?? 'existing'); }
    sessionRef(projectId, sessionId) { const id = sessionId ? this.store.getControl(`workflow-model-session:${sessionId}`) ?? 'existing' : this.pin(projectId); this.assertEnabled(this.profile(id).connectionId); return this.ref(id); }
    bindSession(id, profileId) { this.store.setPrivateConfiguration(`workflow-model-session:${id}`, profileId); }
    requireIdle(projectId) { const project = this.store.getProject(projectId); if (!project)
        throw new StoreError('not_found', 'Project not found'); if (this.store.getActiveLease(project.path) || this.store.listAssignments(projectId).some(a => ['queued', 'running', 'cancelling', 'blocked', 'needs_review'].includes(a.state)))
        throw new StoreError('writer_active', 'Review or stop the current assignment before changing the project model'); }
    settings(projectId) { const c = this.catalog(); return { connections: c.connections.map(({ credential, ...v }) => ({ ...v, authentication: v.noAuth ? 'none' : 'configured', available: !v.disabled && (v.legacy || this.credentials.has(v.id)) })), profiles: c.profiles.map(p => { const connection = this.connection(p.connectionId), lastTest = this.store.getControl(`workflow-model-test:${p.id}`); return { ...p, lastTest: !connection.disabled && lastTest?.credentialRevision === (connection.credentialRevision ?? 1) ? lastTest : null }; }), credentialCleanupPending: (this.store.getControl('workflow-credential-cleanup') ?? []).length, defaultProfileId: c.defaultProfileId, projectId: projectId ?? null, projectProfileId: projectId ? this.projectChoice(projectId) : null, projectPinned: projectId ? !!this.store.getControl(`workflow-model-project:${projectId}`) : false, fallback: 'none' }; }
    async run(method, p) {
        if (method === 'models.settings')
            return this.settings(p.projectId);
        if (method === 'models.discover')
            return this.discover(text(p, 'connectionId'));
        if (method === 'models.test')
            return this.test(text(p, 'profileId'));
        const requestId = text(p, 'requestId', 200), scope = `${method}:${requestId}`;
        // Hash includes key for conflict detection, but neither journal nor audit stores the key.
        const fingerprint = createHash('sha256').update(JSON.stringify(canonical(p))).digest('hex');
        const receiptKey = `workflow-model-receipt:${scope}`;
        const prior = this.store.getControl(receiptKey);
        if (prior) {
            if (prior.fingerprint !== fingerprint)
                throw new StoreError('conflict', 'Settings request changed');
            return this.mutationTail.then(async () => { await this.cleanCredentials(); return prior.result; });
        }
        if (this.pending.has(scope)) {
            await this.pending.get(scope);
            return this.run(method, p);
        }
        const work = this.mutationTail.then(() => this.mutate(method, p, (result, save) => this.store.withTransaction(() => { save(); this.store.setPrivateConfiguration(receiptKey, { fingerprint, result }); this.store.appendActivity({ kind: "settings.changed", projectId: typeof p.projectId === "string" ? p.projectId : null, assignmentId: null, requestId, dedupKey: scope, data: { method, result } }); return result; })));
        this.mutationTail = work.catch(() => { });
        this.pending.set(scope, work);
        try {
            return await work;
        }
        finally {
            this.pending.delete(scope);
        }
    }
    assertEnabled(id) { const c = this.connection(id); if (c.disabled)
        throw new StoreError('connection_disabled', 'This connection is disabled. Choose a replacement explicitly; no fallback is allowed.'); return c; }
    requireConnectionIdle(id) {
        for (const a of this.store.listAssignments()) {
            const profileId = a.sessionId ? this.store.getControl(`workflow-model-session:${a.sessionId}`) ?? 'existing' : this.projectChoice(a.projectId);
            if (this.profile(profileId).connectionId === id && (a.leasePath || ['running', 'queued', 'cancelling'].includes(a.state)))
                throw new StoreError('writer_active', 'Stop and join work using this connection before changing its credential or revoking it.');
        }
    }
    queueCredentialCleanup(path) { if (!this.ownedCredential(path))
        return; const pending = this.store.getControl('workflow-credential-cleanup') ?? []; this.store.setPrivateConfiguration('workflow-credential-cleanup', [...new Set([...pending, path])]); }
    async cleanCredentials() { for (const path of this.store.getControl('workflow-credential-cleanup') ?? []) {
        try {
            if (this.ownedCredential(path) && !this.catalog().connections.some(c => !c.disabled && c.credential.apiKeyFile === path))
                await rm(path, { force: true });
            const pending = this.store.getControl('workflow-credential-cleanup') ?? [];
            this.store.setPrivateConfiguration('workflow-credential-cleanup', pending.filter(p => p !== path));
        }
        catch { /* Keep durable cleanup pending; never undo an applied rotation/revocation. */ }
    } }
    ownedCredential(path) { return !!path && dirname(resolve(path)) === resolve(this.config.paths.stateDir, 'model-credentials') && /^[0-9a-f-]{36}\.key$/.test(basename(path)); }
    async mutate(method, p, commit) {
        if (['models.connection.rotate', 'models.connection.disable', 'models.connection.rename'].includes(method)) {
            const id = text(p, 'connectionId'), catalog = this.catalog(), connection = catalog.connections.find(c => c.id === id);
            if (!connection)
                throw new StoreError('not_found', 'Connection not found');
            if (method === 'models.connection.rename') {
                connection.name = text(p, 'name', 100);
                return commit({ connectionId: id, name: connection.name }, () => this.store.setPrivateConfiguration(KEY, catalog));
            }
            if (connection.legacy)
                throw new StoreError('legacy_connection', 'The original connection is externally configured. Add and select a replacement; this operation never changes its config or credential file.');
            this.requireConnectionIdle(id);
            const previous = connection.credential.apiKeyFile;
            if (method === 'models.connection.disable') {
                if (this.profile(catalog.defaultProfileId).connectionId === id)
                    throw new StoreError('default_in_use', 'Choose a different default model before disabling this connection.');
                connection.disabled = true;
                const result = commit({ connectionId: id, disabled: true }, () => { this.store.setPrivateConfiguration(KEY, catalog); this.queueCredentialCleanup(previous); });
                this.credentials.delete(id);
                await this.cleanCredentials();
                return result;
            }
            this.assertEnabled(id);
            if (p.noAuth !== true && (typeof p.apiKey !== 'string' || !p.apiKey.trim() || p.apiKey.length > 16384))
                throw new StoreError('invalid_params', 'Supply a private API key or explicitly choose no authentication');
            const path = join(this.config.paths.stateDir, 'model-credentials', `${randomUUID()}.key`);
            if (p.noAuth !== true) {
                this.queueCredentialCleanup(path);
                await writeFile(path, p.apiKey.trim(), { mode: 0o600, flag: 'wx' });
            }
            connection.credential = p.noAuth === true ? { none: true } : { apiKeyFile: path };
            connection.noAuth = p.noAuth === true;
            connection.credentialRevision = (connection.credentialRevision ?? 1) + 1;
            try {
                this.requireConnectionIdle(id);
                const result = commit({ connectionId: id, credentialRevision: connection.credentialRevision }, () => { this.store.setPrivateConfiguration(KEY, catalog); this.queueCredentialCleanup(previous); });
                const apiKey = p.noAuth === true ? 'pi-durable-no-auth' : p.apiKey.trim();
                this.credentials.set(id, { apiKey, source: 'private connection rotation' });
                if (p.noAuth !== true)
                    this.secrets.push(apiKey);
                await this.cleanCredentials();
                return result;
            }
            catch (e) {
                if (this.catalog().connections.find(c => c.id === id)?.credential.apiKeyFile !== path)
                    await rm(path, { force: true });
                throw e;
            }
        }
        if (method === 'models.connection.add') {
            const name = text(p, 'name', 100), endpoint = connectionEndpoint(text(p, 'endpoint', 2000), p.allowInsecureHttp === true), id = randomUUID();
            if (p.noAuth !== true && (typeof p.apiKey !== 'string' || !p.apiKey.trim() || p.apiKey.length > 16384))
                throw new StoreError('invalid_params', 'Supply a private API key or choose no authentication');
            const dir = join(this.config.paths.stateDir, 'model-credentials');
            await mkdir(dir, { recursive: true, mode: 0o700 });
            const path = join(dir, `${id}.key`), credential = p.noAuth === true ? { none: true } : { apiKeyFile: path };
            if (p.noAuth !== true) {
                this.queueCredentialCleanup(path);
                await writeFile(path, p.apiKey.trim(), { mode: 0o600, flag: 'wx' });
            }
            const connection = { id, name, endpoint, credential, noAuth: p.noAuth === true, allowInsecureHttp: p.allowInsecureHttp === true };
            try {
                await this.loadCredential(connection);
                const c = this.catalog();
                if (c.connections.length >= 64)
                    throw new StoreError('limit', 'At most 64 connections');
                c.connections.push(connection);
                const result = commit({ connectionId: id }, () => this.store.setPrivateConfiguration(KEY, c));
                await this.cleanCredentials();
                return result;
            }
            catch (e) {
                if (!this.catalog().connections.some(c => c.id === id)) {
                    this.credentials.delete(id);
                    await rm(path, { force: true });
                }
                throw e;
            }
        }
        const c = this.catalog();
        if (method === 'models.profile.add') {
            const connectionId = text(p, 'connectionId');
            this.assertEnabled(connectionId);
            for (const k of ['contextWindow', 'maxTokens'])
                if (!Number.isSafeInteger(p[k]) || p[k] < 1 || p[k] > 10000000)
                    throw new StoreError('invalid_params', `Supply valid ${k}`);
            if (p.maxTokens >= p.contextWindow)
                throw new StoreError('invalid_params', 'Output limit must be smaller than context window');
            if (c.profiles.length >= 128)
                throw new StoreError('limit', 'At most 128 profiles');
            const profile = { id: randomUUID(), connectionId, name: text(p, 'name', 100), model: text(p, 'model', 200), contextWindow: p.contextWindow, maxTokens: p.maxTokens, reasoning: p.reasoning === true, compat: { ...GENERIC, ...validateCompat(p.compat ?? {}) } };
            c.profiles.push(profile);
            const result = commit({ profile }, () => this.store.setPrivateConfiguration(KEY, c));
            this.register(profile);
            return result;
        }
        const profileId = text(p, 'profileId');
        this.assertEnabled(this.profile(profileId).connectionId);
        if (method === 'models.default') {
            c.defaultProfileId = profileId;
            return commit({ defaultProfileId: profileId }, () => this.store.setPrivateConfiguration(KEY, c));
        }
        if (method === 'models.project') {
            const projectId = text(p, 'projectId');
            this.requireIdle(projectId);
            return commit({ projectId, profileId }, () => { this.pin(projectId, profileId); });
        }
        throw new StoreError('unknown_method', 'Unsupported model operation');
    }
    async discover(id) {
        const c = this.assertEnabled(id);
        const credential = c.legacy ? await resolveCredential(c.credential) : this.credentials.get(id);
        if (!credential)
            throw new StoreError('credential', 'Connection credential unavailable');
        try {
            const r = await fetch(`${c.endpoint.replace(/\/+$/, '')}/models`, { headers: c.noAuth ? {} : { Authorization: `Bearer ${credential.apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
            if (!r.ok)
                throw new Error();
            const raw = await boundedBody(r, 1024 * 1024);
            const data = JSON.parse(raw);
            return { models: (Array.isArray(data.data) ? data.data : []).map((m) => m.id).filter((id) => typeof id === 'string' && id.length <= 200).slice(0, 500) };
        }
        catch {
            throw new StoreError('connection_failed', 'Discovery failed. Check endpoint/authentication or enter the exact model ID manually');
        }
    }
    async test(id) {
        const p = this.profile(id);
        const connection = this.assertEnabled(p.connectionId), credentialRevision = connection.credentialRevision ?? 1;
        const ref = this.ref(id), models = this.models(), model = models.getModel(ref.provider, ref.modelId);
        if (!model)
            throw new StoreError('not_found', 'Model unavailable');
        const nonce = randomUUID(), signal = AbortSignal.timeout(60000), messages = [{ role: 'user', content: `Call the readiness_echo tool with value ${nonce}. After receiving the tool result, reply with exactly its value.`, timestamp: Date.now() }];
        const tools = [{ name: 'readiness_echo', description: 'Echo a readiness value. No file access or side effects.', parameters: Type.Object({ value: Type.String() }) }];
        let result;
        try {
            const first = await models.completeSimple(model, { messages, tools }, { signal, maxTokens: Math.min(p.maxTokens, 2048) });
            const call = first.content.find((v) => v.type === 'toolCall' && v.name === 'readiness_echo');
            if (!call || call.type !== 'toolCall' || call.arguments.value !== nonce)
                throw new Error();
            messages.push(first, { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: nonce }], isError: false, timestamp: Date.now() });
            const last = await models.completeSimple(model, { messages, tools }, { signal, maxTokens: Math.min(p.maxTokens, 2048) });
            const output = last.content.filter((v) => v.type === 'text').map((v) => v.text).join('').trim();
            if (last.stopReason !== 'stop' || output !== nonce)
                throw new Error();
            result = { profileId: id, ok: true, at: Date.now(), detail: 'Streaming tool-call and tool-result round trip passed. Project coding and GUI wake acceptance are separate checks.' };
        }
        catch {
            result = { profileId: id, ok: false, at: Date.now(), detail: 'Model readiness failed. Check connection, model ID, tool calling and compatibility settings.' };
        }
        const current = this.connection(p.connectionId);
        if (current.disabled || (current.credentialRevision ?? 1) !== credentialRevision)
            return { profileId: id, ok: false, stale: true, at: Date.now(), detail: 'Connection changed during this check. Test the current credential again.' };
        result.credentialRevision = credentialRevision;
        this.store.setPrivateConfiguration(`workflow-model-test:${id}`, result);
        return result;
    }
}
async function boundedBody(r, max) { const reader = r.body.getReader(); let bytes = 0; const chunks = []; try {
    for (;;) {
        const x = await reader.read();
        if (x.done)
            break;
        bytes += x.value.length;
        if (bytes > max)
            throw new Error();
        chunks.push(x.value);
    }
    return Buffer.concat(chunks).toString('utf8');
}
finally {
    await reader.cancel();
} }
function canonical(v) { return Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v; }
//# sourceMappingURL=model-settings.js.map