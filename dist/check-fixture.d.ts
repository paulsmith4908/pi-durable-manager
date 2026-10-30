/** A single recorded request: enough to prove the transport dialed us. */
export interface FixtureRequestRecord {
    readonly index: number;
    readonly model: string | null;
    readonly messageCount: number;
    readonly toolNames: readonly string[];
}
/** Deterministic file the fixture writes into the sandboxed project. */
export declare const FIXTURE_FILE_NAME = "hello.txt";
/** Exact bytes the fixture writes; the check asserts these verbatim. */
export declare const FIXTURE_FILE_CONTENT = "hello from the deterministic fixture\n";
/** The command the fixture asks the worker to run (a real, sandboxed exec). */
export declare const FIXTURE_TEST_COMMAND = "cat hello.txt && echo FIXTURE_TEST_OK";
export interface FixtureServer {
    /** Absolute base URL ending in `/v1` (the OpenAI SDK appends the path). */
    readonly baseUrl: string;
    readonly port: number;
    /** Every request the production transport made, in order. */
    readonly requests: FixtureRequestRecord[];
    /** Number of `chat.completions` requests served. */
    readonly requestCount: () => number;
    /** Stop the server and free the port. */
    readonly close: () => Promise<void>;
}
/**
 * Start the fixture server bound to loopback on an ephemeral port.
 *
 * The returned `baseUrl` is `http://127.0.0.1:<port>/v1`; the production
 * transport appends `/chat/completions`.
 */
export declare function startFixtureServer(options?: {
    /** Explicit fixture-only command for crash/recovery acceptance tests. Never a runtime provider setting. */
    command?: string;
    label?: string;
    /**
     * Delay (ms) applied before EVERY scripted turn is served. Used by tests to
     * simulate a SLOW real provider whose response arrives AFTER the online
     * check's bounded observation window — proving the run still progresses to a
     * terminal wake event once the daemon (left running) delivers it. Default 0.
     */
    delayMs?: number;
}): Promise<FixtureServer>;
//# sourceMappingURL=check-fixture.d.ts.map