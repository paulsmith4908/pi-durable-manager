/**
 * `pi-durable setup` — the friendly guided entry point.
 *
 * Two modes:
 *   * Noninteractive: every value supplied by a flag; ideal for scripts and for
 *     the tests. `--json` yields one envelope on stdout.
 *   * Interactive: when stdin is a TTY and required values are missing, small
 *     prompts collect them. Prompts NEVER ask for a raw key — only for a
 *     reference (env var name or existing private file path).
 *
 * Truthfulness rules: a failure exits non-zero with `ok:false`; a dry-run never
 * writes; `--json` stdout is exactly one JSON object.
 */
import { BETA_VERSION, DEFAULT_CONFIG_RELATIVE, type CommandProbe, type SetupCheck, type SetupDeps, type SetupReport, type SetupRequest, validateCredentialReference } from "./setup.js";
/** The `setup` help text (also used by `setup --help --json`). */
export declare const SETUP_HELP: string;
/** Everything the CLI needs from the process, injectable for tests. */
export interface SetupCliDeps {
    readonly deps: SetupDeps;
    /** Prompt the user for a line of input. Only used in interactive mode. */
    readonly prompt?: (question: string) => Promise<string>;
    /** True when stdin is an interactive TTY. */
    readonly isTty: boolean;
    /**
     * Force the guided interactive flow even when not attached to a TTY (used by
     * tests and by `PI_DURABLE_SETUP_INTERACTIVE=1`). Callers must supply a
     * `prompt` that terminates — a closed stdin resolves the pending question with
     * an empty line so the flow fails fast rather than hanging.
     */
    readonly forceInteractive?: boolean;
    /** Sink for human-readable progress (defaults to a no-op so --json stays clean). */
    readonly log?: (line: string) => void;
}
/**
 * Flags the manager wake path passes to `codex queue` and therefore requires.
 *
 * The real supported `codex queue` interface is:
 *   `codex queue [OPTIONS] --thread <THREAD> --message <TEXT>`
 * (verified against the hosted Codex CLI `queue --help`). We require exactly the
 * flags the dispatcher passes — `--thread` and `--message` — never the old,
 * unsupported `--thread-id`/`--prompt` spellings.
 */
export declare const REQUIRED_QUEUE_FLAGS: readonly ["thread", "message"];
/**
 * Probe a command for availability and (for Codex) real wake readiness.
 *
 * `codex --version` is deliberately NOT trusted: any stub can print a version
 * (or exit 0/2) without being able to enqueue work. For Codex we run the actual
 * subcommand the manager uses, `codex queue --help`, and look for the required
 * flags. Probing never passes a credential and never runs the model.
 */
export declare function defaultProbeCommand(cmd: string): Promise<CommandProbe>;
/**
 * A minimal, secret-free environment for probing external executables. We pass
 * only PATH/HOME/lang basics — never the parent's full env (which may hold API
 * keys) — so a probed binary can never exfiltrate or read credentials.
 */
export declare function minimalProbeEnv(): NodeJS.ProcessEnv;
/**
 * Discover the Codex app/CLI executable the manager should record. Prefers an
 * explicit `--codex-executable`, then `codex` on PATH, then well-known app-bundle
 * locations. Returns the absolute resolved path when found (so the config never
 * bakes a personal, machine-specific path unless it actually exists there).
 */
export declare function discoverAppExecutable(preferred?: string): string | undefined;
/**
 * Discover a Codex CLI bundled inside an installed app (e.g. the ChatGPT desktop
 * app ships one under `Contents/Resources/codex-cli/`). Generic: scans the
 * standard macOS application directories for `*.app` bundles and looks for a
 * bundled `codex` executable under the well-known relative locations. Returns
 * the first executable found, or `undefined`. No personal user path is baked in
 * — only app-global compatibility locations relative to standard app dirs.
 */
export declare function discoverBundledCodex(): string | undefined;
/**
 * Probe Codex by running `queue --help` (the subcommand the manager uses) and
 * checking for the required flags. A non-zero exit, empty output, or missing
 * flag is reported truthfully so setup can warn instead of falsely passing.
 */
export declare function probeCodexQueue(cmd: string): CommandProbe;
/** Build the default production {@link SetupDeps}. */
export declare function defaultSetupDeps(env?: NodeJS.ProcessEnv): SetupDeps;
/** Parse flags into a {@link SetupRequest}. Missing interactive values are left undefined. */
export declare function requestFromFlags(flags: ReadonlyMap<string, string>, home: string, booleanValues?: ReadonlyMap<string, boolean>): Partial<SetupRequest>;
/** Fill any missing required values interactively (never asks for a raw key). */
export declare function collectInteractive(partial: Partial<SetupRequest>, cli: SetupCliDeps): Promise<SetupRequest>;
/**
 * Run the `setup` command. Returns the process exit code.
 *
 * `argv` is the argv AFTER the `setup` token. `cli.deps` supplies all side
 * effects so tests can run entirely inside a temp dir.
 */
export declare function runSetupCommand(argv: readonly string[], cli: SetupCliDeps): Promise<number>;
/**
 * Resolve the absolute path to this package's CLI entry point (`bin/pi-durable.js`)
 * from a directory inside the package (`dist/`). Used to record a real `bin`
 * pointer so an installed skill can launch the CLI without relying on PATH.
 */
export declare function resolvePackageCliPath(fromDir: string): string;
/**
 * Collect the JSON summary of the environment without writing anything. Used by
 * the `--json` dry-run path in integration tests to assert no writes occurred.
 */
export declare function setupSummaryLine(report: SetupReport): string;
export { BETA_VERSION, DEFAULT_CONFIG_RELATIVE, validateCredentialReference };
export type { SetupCheck, SetupDeps, SetupReport };
//# sourceMappingURL=cli-setup.d.ts.map