import { type Server } from 'node:http';
import type { Terminal } from '@earendil-works/pi-tui';
import { type ObserverRpc } from './native-terminal.js';
/** Bridges the real Pi TUI's VT output, not HTML message imitations, into xterm. */
export declare class BrowserTerminal implements Terminal {
    columns: number;
    rows: number;
    private readonly output;
    kittyProtocolActive: boolean;
    private resizeHandler;
    constructor(columns: number, rows: number, output: (data: string) => void);
    start(_input: (data: string) => void, resize: () => void): void;
    stop(): void;
    drainInput(): Promise<void>;
    write(data: string): void;
    resize(columns: number, rows: number): void;
    moveBy(lines: number): void;
    hideCursor(): void;
    showCursor(): void;
    clearLine(): void;
    clearFromCursor(): void;
    clearScreen(): void;
    setTitle(_title: string): void;
    setProgress(_active: boolean): void;
    setProgramStatus(): void;
}
export declare function startTerminalBrowser(options: {
    stateDir: string;
    port?: number;
    assignmentId?: string;
    socketPath?: string;
    rpc?: ObserverRpc;
}): Promise<{
    server: Server;
    url: string;
    close(): Promise<void>;
}>;
//# sourceMappingURL=native-terminal-browser.d.ts.map