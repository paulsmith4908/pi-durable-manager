import { type Models } from '@earendil-works/pi-ai';
import { type PiDurableConfig, type CredentialRef, type CompatOverrides } from './config.js';
import { MetadataStore } from './store.js';
import { workerCompactionPolicy } from './context-policy.js';
export declare const MODEL_OPERATIONS: {
    readonly 'models.settings': {
        readonly params: readonly ["projectId"];
        readonly summary: "Saved connections, profiles, default and project choice. No credentials returned.";
    };
    readonly 'models.connection.add': {
        readonly params: readonly ["name", "endpoint", "apiKey", "noAuth", "allowInsecureHttp", "requestId"];
        readonly requestId: "requestId";
        readonly summary: "Add an immutable connection. Enter keys only in the private Settings page.";
    };
    readonly 'models.profile.add': {
        readonly params: readonly ["connectionId", "name", "model", "contextWindow", "maxTokens", "reasoning", "compat", "requestId"];
        readonly requestId: "requestId";
        readonly summary: "Add an immutable OpenAI-compatible model profile with explicit limits.";
    };
    readonly 'models.default': {
        readonly params: readonly ["profileId", "requestId"];
        readonly requestId: "requestId";
        readonly summary: "Choose the default for new projects only.";
    };
    readonly 'models.project': {
        readonly params: readonly ["projectId", "profileId", "requestId"];
        readonly requestId: "requestId";
        readonly summary: "Choose a project model while no assignment is active; no automatic fallback.";
    };
    readonly 'models.discover': {
        readonly params: readonly ["connectionId"];
        readonly summary: "Discover advertised models; manual model IDs remain supported.";
    };
    readonly 'models.test': {
        readonly params: readonly ["profileId"];
        readonly summary: "Run a bounded streaming tool-call and tool-result round trip. No project files or tools executed.";
    };
};
interface Connection {
    id: string;
    name: string;
    endpoint: string;
    credential: CredentialRef;
    noAuth: boolean;
    allowInsecureHttp: boolean;
    legacy?: boolean;
}
export interface ModelProfile {
    id: string;
    connectionId: string;
    name: string;
    model: string;
    contextWindow: number;
    maxTokens: number;
    reasoning: boolean;
    compat: CompatOverrides;
    legacy?: boolean;
}
interface Catalog {
    connections: Connection[];
    profiles: ModelProfile[];
    defaultProfileId: string;
}
export declare function connectionEndpoint(value: string, allowInsecureHttp?: boolean): string;
/** Immutable profiles pin session semantics. No credential bytes enter metadata, journals or responses. */
export declare class ModelSettings {
    private store;
    private config;
    private legacyModels;
    private legacyProvider;
    private secrets;
    readonly compaction: Record<string, ReturnType<typeof workerCompactionPolicy>>;
    private credentials;
    private extra;
    private pending;
    constructor(store: MetadataStore, config: PiDurableConfig, legacyModels: () => Models, legacyProvider: string, secrets: string[]);
    catalog(): Catalog;
    profile(id: string): ModelProfile;
    connection(id: string): Connection;
    initialize(): Promise<void>;
    private loadCredential;
    private register;
    models(): Models;
    ref(id: string): {
        provider: string;
        modelId: string;
    };
    projectChoice(projectId: string): string;
    pin(projectId: string, requested?: string): string;
    sessionRef(projectId: string, sessionId?: string): {
        provider: string;
        modelId: string;
    };
    bindSession(id: string, profileId: string): void;
    private requireIdle;
    settings(projectId?: string): {
        connections: {
            authentication: string;
            available: boolean;
            id: string;
            name: string;
            endpoint: string;
            noAuth: boolean;
            allowInsecureHttp: boolean;
            legacy?: boolean;
        }[];
        profiles: {
            lastTest: unknown;
            id: string;
            connectionId: string;
            name: string;
            model: string;
            contextWindow: number;
            maxTokens: number;
            reasoning: boolean;
            compat: CompatOverrides;
            legacy?: boolean;
        }[];
        defaultProfileId: string;
        projectId: string | null;
        projectProfileId: string | null;
        projectPinned: boolean;
        fallback: string;
    };
    run(method: string, p: Record<string, any>): Promise<any>;
    private mutate;
    private discover;
    private test;
}
export {};
//# sourceMappingURL=model-settings.d.ts.map