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
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CliUsageError, parseArgs } from "./cli-args.js";
import { errorEnvelope, okEnvelope, serializeEnvelope } from "./cli-status.js";
import { redactString } from "./redact.js";
import { defaultSetupDeps } from "./cli-setup.js";
import { renderCheck, runOfflineCheck, runOnlineCheck, verifyOnlineCheck } from "./check.js";
/** `check` help text. */
export const CHECK_HELP = [
    "pi-durable check — end-to-end health check for the beta",
    "",
    "Usage:",
    "  pi-durable check [--offline] [--json]        (default: offline isolated fixture run)",
    "  pi-durable check --online --thread-id UUID [--config PATH] [--json]",
    "  pi-durable check --verify RUN_ID [--config PATH] [--json]",
    "",
    "Offline (default) proves, inside ONE fresh temp dir (deleted afterwards):",
    "  guided setup writes a private config; a real isolated service starts on a",
    "  loopback socket; a project + session are created; capabilities and",
    "  reconnect work; secret redaction holds; a replayed request is idempotent.",
    "  All inference in this mode is a DETERMINISTIC LOCAL FIXTURE, clearly labelled.",
    "",
    "Online performs REAL inference/wake against your configured endpoint and",
    "records a run with all ids bound to the thread UUID you supply. It never",
    "invents a thread id and never reports a fake successful dispatch or ack, and",
    "it never auto-accepts or auto-acks unreviewed output. Run it yourself (or have",
    "the manager run it) once you have provisioned a real key.",
    "",
    "Options:",
    "  --offline           Isolated fixture run (default).",
    "  --online            Real endpoint run; requires --thread-id.",
    "  --thread-id UUID    Your Codex thread UUID that owns the wake receipt.",
    "  --verify RUN_ID     Re-open a persisted online run and report its state.",
    "  --config PATH       Config for online mode (default ~/.config/pi-durable-manager/config.json).",
    "  --json              Emit one JSON envelope on stdout.",
    "  --help              Show this help.",
    "",
].join("\n");
/** Locate the CLI bin lazily (packaged tree: dist/ → ../bin/pi-durable.js). */
function resolveBinPath() {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        join(here, "..", "bin", "pi-durable.js"),
        join(here, "bin", "pi-durable.js"),
    ];
    for (const c of candidates)
        if (existsSync(c))
            return c;
    throw new CliUsageError("no_bin", "Could not locate the pi-durable CLI bin for the isolated service.");
}
/**
 * Run the `check` command. Returns the process exit code (non-zero iff any step
 * FAILs, or the invocation itself is invalid).
 */
export async function runCheckCommand(argv, io = {
    home: defaultSetupDeps().home,
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
}) {
    const parsed = parseArgs(argv);
    const json = parsed.booleans.has("json");
    const emit = (envelope) => {
        if (json)
            io.stdout(serializeEnvelope(envelope));
    };
    if (parsed.booleans.has("help")) {
        if (json)
            emit(okEnvelope({ help: CHECK_HELP }));
        else
            io.stdout(CHECK_HELP);
        return 0;
    }
    const online = parsed.booleans.has("online");
    const offline = parsed.booleans.has("offline");
    const verifyRunId = parsed.flags.get("verify");
    if (online && offline) {
        throw new CliUsageError("mode_conflict", "Choose one of --offline or --online.");
    }
    if (verifyRunId !== undefined && (online || offline)) {
        throw new CliUsageError("mode_conflict", "--verify cannot be combined with --online or --offline.");
    }
    try {
        let report;
        if (verifyRunId !== undefined) {
            if (verifyRunId.trim() === "") {
                throw new CliUsageError("missing_run_id", "--verify requires a run id.");
            }
            const configPath = parsed.flags.get("config") ?? join(io.home, ".config", "pi-durable-manager", "config.json");
            report = await verifyOnlineCheck({
                runId: verifyRunId.trim(),
                configPath,
                binPath: resolveBinPath(),
                log: (line) => io.stderr(`${line}\n`),
            });
        }
        else if (online) {
            const threadId = parsed.flags.get("thread-id");
            if (threadId === undefined || threadId.trim() === "") {
                throw new CliUsageError("missing_thread_id", "--online requires --thread-id <your Codex thread UUID>. Checks never invent a thread id.");
            }
            const configPath = parsed.flags.get("config") ?? join(io.home, ".config", "pi-durable-manager", "config.json");
            report = await runOnlineCheck({
                deps: defaultSetupDeps(),
                binPath: resolveBinPath(),
                configPath,
                threadId: threadId.trim(),
                log: (line) => io.stderr(`${line}\n`),
            });
        }
        else {
            report = await runOfflineCheck({
                deps: defaultSetupDeps(),
                binPath: resolveBinPath(),
                log: (line) => io.stderr(`${line}\n`),
            });
        }
        if (json)
            emit({ ok: report.ok, result: report });
        else
            io.stdout(renderCheck(report));
        return report.ok ? 0 : 1;
    }
    catch (error) {
        if (error instanceof CliUsageError) {
            if (json)
                emit(errorEnvelope(error.code, error.message));
            else
                io.stderr(`error: ${error.message}\n`);
            return error.exitCode;
        }
        const message = redactString(error.message);
        if (json)
            emit(errorEnvelope("check_failed", message));
        else
            io.stderr(`error: ${message}\n`);
        return 1;
    }
}
export { CHECK_HELP as help };
//# sourceMappingURL=cli-check.js.map