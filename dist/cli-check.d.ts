/**
 * `pi-durable check` CLI wiring.
 *
 * Default mode is OFFLINE (isolated, fixture inference). `--online` requires an
 * explicit `--thread-id` and performs real inference/wake — it is intended for
 * a human or the manager, never for automated CI.
 *
 * `--json` emits exactly one envelope on stdout; progress for humans goes to
 * stderr so the JSON stream stays parseable.
 */
/** `check` help text. */
export declare const CHECK_HELP: string;
/**
 * Run the `check` command. Returns the process exit code (non-zero iff any step
 * FAILs, or the invocation itself is invalid).
 */
export declare function runCheckCommand(argv: readonly string[], io?: {
    home: string;
    stdout: (s: string) => void;
    stderr: (s: string) => void;
}): Promise<number>;
export { CHECK_HELP as help };
//# sourceMappingURL=cli-check.d.ts.map