import { type Server } from "node:http";
export interface LiveOptions {
    after?: number;
    projectId?: string;
    once?: boolean;
    json?: boolean;
    signal?: AbortSignal;
    socketPath?: string;
}
/** Read-only actual terminal viewer. A disappearing viewer never stops the daemon or workers. */
export declare function watchActivity(configPath: string, options: LiveOptions, write?: (text: string) => void): Promise<void>;
export declare function startLiveConsole(configPath: string, options?: {
    port?: number;
    projectId?: string;
    socketPath?: string;
}): Promise<{
    server: Server;
    url: string;
}>;
//# sourceMappingURL=live-console.d.ts.map