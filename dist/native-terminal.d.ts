import { Container, Text, ScrollView, TuiAltScreen, type Terminal, type Component } from '@earendil-works/pi-tui';
import type { ActivityEntry } from './activity.js';
type Ui = typeof import('../vendor/pi-ui/components.mjs');
type Row = Record<string, any>;
export interface ObserverRpc {
    call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}
export declare const OBSERVER_METHODS: Set<string>;
export declare function readOnlyRpc(rpc: ObserverRpc): ObserverRpc;
/** Never fetch assignment detail: it embeds the entire growing evidence bundle. */
export declare function readAssignmentSummary(rpc: ObserverRpc, id: string, projectId?: string): Promise<Row>;
/** A large journal page is retried at the SAME cursor; never skip recorded output. */
export declare function readActivityPage(rpc: ObserverRpc, projectId: string, after: number): Promise<{
    entries: ActivityEntry[];
    nextCursor: number;
}>;
export declare function recentActivityCursor(checks: Row, assignmentId: string): number;
/** Only fixed messages/codes reach the UI; raw transport errors may contain private paths. */
export declare function observerError(error: unknown): {
    code: string;
    message: string;
};
export declare function packageRoot(): string;
export declare function loadPiUi(): Promise<Ui>;
/** Worker output is text, never a terminal control channel (including clipboard OSC). */
export declare function terminalText(value: unknown): string;
declare class StatusLines implements Component {
    private value;
    setText(text: string): void;
    render(width: number): string[];
    invalidate(): void;
}
/** Reuses Pi Coding Agent's actual published message/tool components, unmodified. */
export declare class PiWorkerDisplay {
    readonly ui: Ui;
    readonly tui: TuiAltScreen;
    readonly assignment: Row;
    readonly project: Row;
    readonly body: Container;
    readonly header: Text;
    readonly footer: StatusLines;
    readonly scroll: ScrollView;
    private tools;
    private latestTools;
    private completedCommands;
    private pendingBash;
    private expanded;
    private shown;
    private seen;
    private lastSeq;
    private state;
    constructor(ui: Ui, tui: TuiAltScreen, assignment: Row, project: Row);
    ingest(entries: ActivityEntry[]): void;
    updateStatus(service: Row, assignment: Row, checks: Row, manager: Row, guard: Row | null): void;
    error(message: string): void;
    action(action: string): void;
    describe(): Row;
}
export declare function connectObserver(stateDir: string, socketPath?: string): Promise<{
    rpc: ObserverRpc;
    close(): void;
}>;
export declare function observeWorker(options: {
    rpc: ObserverRpc;
    terminal: Terminal;
    stateDir: string;
    assignmentId: string;
    signal: AbortSignal;
    onDisplay?: (display: PiWorkerDisplay) => void;
    onQuit?: () => void;
}): Promise<void>;
export declare function runNativeObserver(stateDir: string, assignmentId: string, signal: AbortSignal, socketPath?: string): Promise<void>;
export {};
//# sourceMappingURL=native-terminal.d.ts.map