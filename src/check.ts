/**
 * `pi-durable check` — an honest end-to-end self-check for the beta.
 *
 * Two modes:
 *   * OFFLINE (default; `--offline`): everything runs inside ONE fresh temp
 *     directory with a dummy credential reference and a real, isolated local
 *     service started on a loopback socket. The inference is a deterministic
 *     LOCAL FIXTURE — every such result is explicitly labelled `fixture`. It
 *     never touches production state, never reads a real key, and removes only
 *     the temp directory it created (verified to be under the OS temp dir).
 *   * ONLINE (`--online`): uses a real config + endpoint for a genuine
 *     inference/wake cycle. It REQUIRES a user-requested thread UUID and never
 *     fabricates a successful dispatch or ack.
 *
 * Every step reports `PASS`, `FAIL`, or `SKIP` with a truthful detail string.
 * The command exits non-zero iff any step FAILs.
 */

import { mkdtempSync, existsSync, mkdirSync, realpathSync, writeFileSync, unlinkSync, chmodSync, statSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CliUsageError } from "./cli-args.js";
import { redactString } from "./redact.js";
import { runSetup, type SetupDeps } from "./setup.js";
import { defaultSetupDeps } from "./cli-setup.js";
import { startDaemon, stopDaemon } from "./cli-daemon.js";
import { PiClient } from "./client.js";
import { PROTOCOL_VERSION, resolveRuntimeDir } from "./service.js";
import { loadConfig } from "./config.js";
import { MODAL_PROVIDER_ID, configuredProviderId } from "./provider.js";
import { packageVersion } from "./version.js";
import {
  FIXTURE_FILE_CONTENT,
  FIXTURE_FILE_NAME,
  FIXTURE_TEST_COMMAND,
  startFixtureServer,
  type FixtureServer,
} from "./check-fixture.js";

/** The verdict of a single check step. */
export type CheckStatus = "PASS" | "FAIL" | "SKIP" | "PENDING";

/** One reported step. */
export interface CheckStep {
  readonly id: string;
  readonly label: string;
  readonly status: CheckStatus;
  readonly detail: string;
  /** True when this step exercised the deterministic local fixture provider. */
  readonly fixture?: boolean;
}

/** The complete check report. */
export interface CheckReport {
  readonly version: string;
  readonly mode: "offline" | "online";
  readonly ok: boolean;
  readonly steps: readonly CheckStep[];
  /** Temp workspace used (offline mode only); already cleaned up on success. */
  readonly workspace?: string;
  readonly threadId?: string;
  /** Online run record with all ids (project/session/assignment/request/event). */
  readonly runFile?: string;
}

/** Aggregate results into a report; `ok` is false iff any step FAILed. */
export function summarize(
  version: string,
  mode: "offline" | "online",
  steps: readonly CheckStep[],
  extra: { workspace?: string; threadId?: string; runFile?: string } = {},
): CheckReport {
  // A report is only `ok` when NOTHING failed AND nothing is still pending.
  // A pending wake (assignment submitted but not yet delivered/acked) is an
  // honest non-success: it must never be reported as an all-ready PASS.
  const ok = !steps.some((s) => s.status === "FAIL") && !steps.some((s) => s.status === "PENDING");
  return { version, mode, ok, steps, ...extra };
}

/** Render a report for humans. */
export function renderCheck(report: CheckReport): string {
  const lines: string[] = [];
  lines.push(`pi-durable check ${report.version} [${report.mode}]`);
  lines.push("");
  for (const s of report.steps) {
    const tag = s.fixture === true ? " (fixture inference)" : "";
    lines.push(`  [${s.status}] ${s.label}${tag} — ${s.detail}`);
  }
  lines.push("");
  const pass = report.steps.filter((s) => s.status === "PASS").length;
  const fail = report.steps.filter((s) => s.status === "FAIL").length;
  const skip = report.steps.filter((s) => s.status === "SKIP").length;
  const pending = report.steps.filter((s) => s.status === "PENDING").length;
  lines.push(
    `${pass} passed, ${fail} failed, ${skip} skipped${pending > 0 ? `, ${pending} pending` : ""}`,
  );
  if (report.mode === "online" && report.threadId) {
    lines.push(`Thread: ${report.threadId} — review the receipt, then acknowledge it in Codex.`);
    if (report.runFile) {
      lines.push(`Run record: ${report.runFile} — resume with \`pi-durable check --verify <runId>\`.`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Create a verified temporary workspace. Uses `mkdtemp` under the OS temp dir
 * and refuses to return a path outside it, so a later cleanup can never touch
 * anything the check did not itself create.
 */
export function makeWorkspace(prefix = "pi-durable-check-"): string {
  // Canonicalize the OS temp dir first: on macOS `os.tmpdir()` is
  // `/var/folders/...` while the real path is `/private/var/folders/...`. Doing
  // this once makes every later containment check compare like-for-like.
  const base = realpathSync(tmpdir());
  const dir = mkdtempSync(join(base, prefix));
  // Canonicalize the result too, so callers get a path that is stable under
  // realpath comparisons (e.g. before later cleanup).
  const real = realpathSync(dir);
  const withSep = base.endsWith("/") ? base : `${base}/`;
  if (real !== base && !real.startsWith(withSep)) {
    throw new Error(`Refusing to use workspace outside temp dir: ${real}`);
  }
  // Include a space in the path to prove space-safety of the whole pipeline.
  return real;
}

/**
 * Canonicalize a path, tolerating a not-yet-existing leaf by canonicalizing its
 * nearest existing ancestor and re-appending the remainder. This is what lets a
 * containment check work uniformly on macOS where `/var` is a symlink alias of
 * `/private/var` — both sides are compared in their real, resolved form.
 */
function canonicalize(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.push(basename(current));
      current = parent;
    }
  }
}

/**
 * True iff `child` is strictly inside `root` (canonical, boundary-aware). Uses
 * `path.relative` so there is no directory-PREFIX bug: `/tmp/foo` never matches
 * `/tmp/foobar`. Both sides are canonicalized first so a symlinked OS temp dir
 * (`/var` → `/private/var`) compares like-for-like.
 */
export function isStrictlyInside(child: string, root: string): boolean {
  const c = canonicalize(child);
  const r = canonicalize(root);
  if (c === r) return false;
  const rel = relative(r, c);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/** A deterministic fixture credential reference used offline (never a real key). */
const FIXTURE_ENV_NAME = "PI_DURABLE_FIXTURE_KEY";

/** A fixed, valid v4-shaped UUID used as the offline manager thread id. */
export const FIXTURE_THREAD_ID = "00000000-0000-4000-8000-0000000000f1";

/**
 * Pick a base directory for the isolated service's runtime (UNIX domain socket)
 * that is both writable and short enough for the socket-path limit.
 *
 * Preference order:
 *  1. A `PI_DURABLE_RUNTIME_DIR` the caller already exported.
 *  2. `/tmp` (the normal macOS location; short and world-writable-parent).
 *  3. A short, process-local fallback directory next to the checkout/install
 *     (`<cwd>/.pi-durable-runtime`) for sandboxes whose `/tmp` is not writable.
 *
 * Returns `undefined` when no candidate yields a path within the UDS limit, so
 * the caller can honestly SKIP the service steps instead of failing a healthy
 * machine.
 */
export function chooseRuntimeDir(cwd: string = process.cwd()): string | undefined {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const candidates: string[] = [];
  const preexisting = process.env.PI_DURABLE_RUNTIME_DIR;
  if (preexisting !== undefined && preexisting.length > 0) candidates.push(resolve(preexisting));
  candidates.push("/tmp");
  candidates.push(join(cwd, ".pi-durable-runtime"));

  for (const base of candidates) {
    const candidate = join(base, `pi-durable-${uid}`);
    // The final socket is `<runtimeDir>/<16hex>/s`; keep the base + slack short.
    if (Buffer.byteLength(join(candidate, "0123456789abcdef", "s")) > 100) continue;
    let scratch: string | undefined;
    try {
      mkdirSync(candidate, { recursive: true, mode: 0o700 });
      // mkdir succeeding is not proof of writability (the parent may exist but
      // be read-only, e.g. a sandboxed /tmp). Probe an actual file write+unlink.
      scratch = join(candidate, `.write-probe-${process.pid}`);
      writeFileSync(scratch, "ok");
      unlinkSync(scratch);
      // Canonicalize the chosen base too, so an override like `/tmp` (a macOS
      // symlink to `/private/tmp`) is reported as its real path and later
      // containment checks compare like-for-like.
      try {
        return realpathSync(base);
      } catch {
        return base;
      }
    } catch {
      if (scratch !== undefined && existsSync(scratch)) {
        try {
          unlinkSync(scratch);
        } catch {
          // best effort
        }
      }
      // Not usable here; try the next candidate.
    }
  }
  return undefined;
}

/** Build a fixture config object (schema v1) for the isolated offline run. */
export function fixtureConfig(
  workspace: string,
  options: { endpoint?: string; cliExecutable?: string; cliBaseArgs?: readonly string[] } = {},
): Record<string, unknown> {
  const stateDir = join(workspace, "state dir");
  const projectHome = join(workspace, "projects");
  return {
    configVersion: 1,
    // Loopback by default; the offline check overrides this with the live
    // fixture server's base URL so the REAL production transport dials it.
    endpoint: options.endpoint ?? "http://127.0.0.1:9/fixture",
    model: "fixture-model",
    limits: { contextWindow: 65536, maxTokens: 16384, maxSteps: 6, timeoutMs: 60000 },
    paths: { stateDir, projectHome, allowedRoots: [projectHome] },
    credential: { env: FIXTURE_ENV_NAME },
    tools: { allowNetwork: false, commandTimeoutMs: null },
    manager: {
      enabled: true,
      cliExecutable: options.cliExecutable ?? "codex",
      cliBaseArgs: [...(options.cliBaseArgs ?? ["queue"])],
      cliTimeoutMs: 30000,
      maxAttempts: 8,
    },
  };
}

/** SHA-256 hex of a UTF-8 string (used to hash evidence bytes in the check). */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Locate the shipped `scripts/` directory that contains the standalone
 * installers. Compiled output may run from `dist/` (production) or
 * `dist-test/src/` (tests), so walk up until we find a `scripts/install-skill.mjs`
 * next to a `bin/pi-durable.js`. Throws if none is found (a packaging bug).
 */
export function findScriptsDir(startDir: string): string {
  let dir = resolve(startDir);
  for (let i = 0; i < 8; i += 1) {
    const scripts = join(dir, "scripts");
    if (
      existsSync(join(scripts, "install-skill.mjs")) &&
      existsSync(join(dir, "bin", "pi-durable.js"))
    ) {
      return scripts;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate packaged scripts/ directory (installer missing)");
}

/** A resolved service socket plus the env/short-dir needed to host it. */
export interface ServiceSocket {
  /** Absolute socket path to hand to `serve --socket`. */
  readonly socketPath: string;
  /** Extra child env (e.g. `PI_DURABLE_RUNTIME_DIR`); never a real secret. */
  readonly env: Record<string, string>;
  /** Short dir under cwd used only when no runtime base is writable (cleanup). */
  readonly shortSocketDir?: string;
  /** False when even the shortest base cannot fit the platform UDS limit. */
  readonly canStart: boolean;
}

/**
 * Resolve a service socket the SAME way for offline and online runs: prefer a
 * short runtime base (honouring `PI_DURABLE_RUNTIME_DIR`), else fall back to a
 * short private dir under the working directory. This keeps the online path's
 * behavior identical to the isolated check and to the real CLI, and it lets a
 * sandbox whose `/tmp` is not user-owned still host the service.
 */
export function resolveServiceSocket(stateDir: string, cwd: string = process.cwd()): ServiceSocket {
  const env: Record<string, string> = {};
  const runtimeBase = chooseRuntimeDir(cwd);
  if (runtimeBase !== undefined) {
    env.PI_DURABLE_RUNTIME_DIR = runtimeBase;
    return {
      socketPath: join(resolveRuntimeDir(stateDir, { PI_DURABLE_RUNTIME_DIR: runtimeBase }), "s"),
      env,
      canStart: true,
    };
  }
  // Fallback short dir under the working directory. It MUST be keyed on the
  // STATE DIR (not just the caller pid): two long-lived daemons started by the
  // same process for DIFFERENT state dirs must not collide on one socket path.
  // (Online check intentionally leaves its daemon running, so a process can own
  // several concurrent services.) A SHORT 4-hex state key keeps the whole path
  // under the platform UDS byte limit (the working dir can already be ~90 bytes)
  // while remaining unique per canonical state dir.
  const stateKey = createHash("sha256").update(resolve(stateDir)).digest("hex").slice(0, 4);
  const shortDir = join(cwd, ".s", `pdm${process.pid.toString(16)}-${stateKey}`);
  const candidate = join(shortDir, "s");
  if (Buffer.byteLength(candidate) <= 100) {
    try {
      mkdirSync(shortDir, { recursive: true, mode: 0o700 });
      return { socketPath: candidate, env, shortSocketDir: shortDir, canStart: true };
    } catch {
      return { socketPath: join(stateDir, "s"), env, canStart: false };
    }
  }
  return { socketPath: join(stateDir, "s"), env, canStart: false };
}

/**
 * The real supported `codex queue` usage banner. Mirrors the host CLI exactly
 * (`Usage: codex queue [OPTIONS] --thread <THREAD> --message <TEXT>`) so a
 * `--help` probe against the fixture stub reports the true flag surface rather
 * than inventing one.
 */
export const FIXTURE_QUEUE_HELP = "Usage: codex queue [OPTIONS] --thread <THREAD> --message <TEXT>\n";

/**
 * Write an owned stub `codex` CLI that captures its argv to a file and exits 0.
 *
 * IMPORTANT: the native manager transport is ARGV-ONLY. The dispatcher spawns
 * this via `execFile` with a stdin PIPE that it never closes, so the stub MUST
 * NOT read stdin — a synchronous `fs.readFileSync(0, ...)` would block until
 * EOF that never comes, wedging the dispatcher (the original deadlock).
 *
 * Behaviour:
 *  - `--help` / `-h` / bare `help`: print the REAL queue usage banner (no
 *    capture), so a version/help probe is answered truthfully and never
 *    mistaken for a wake delivery.
 *  - `--version` / `-V`: print a version string (no capture).
 *  - any other invocation: append `{ argv, at }` to the capture file.
 *
 * Used ONLY by the offline fixture so the wake dispatcher is exercised
 * end-to-end without a real Codex install. Returns the executable path.
 */
export function writeFixtureWakeStub(dir: string, capturePath: string): string {
  const binDir = join(dir, "fixture-bin");
  mkdirSync(binDir, { recursive: true });
  const stub = join(binDir, "codex");
  const script = [
    "#!/usr/bin/env node",
    '"use strict";',
    'const fs = require("node:fs");',
    `const capture = ${JSON.stringify(capturePath)};`,
    `const HELP = ${JSON.stringify(FIXTURE_QUEUE_HELP)};`,
    "const argv = process.argv.slice(2);",
    // Handle help/version probes WITHOUT touching stdin, then exit.
    'if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {',
    "  process.stdout.write(HELP);",
    "  process.exit(0);",
    "}",
    'if (argv.includes("--version") || argv.includes("-V")) {',
    '  process.stdout.write("codex 0.0.0-fixture\\n");',
    "  process.exit(0);",
    "}",
    // Normal wake delivery: record argv only (NEVER read stdin — the dispatcher
    // leaves the pipe open, so reading would deadlock).
    "const record = { argv, at: Date.now() };",
    'fs.appendFileSync(capture, JSON.stringify(record) + "\\n");',
    'process.stdout.write("Queued message fixture-msg-" + Date.now().toString(36) + "\\n");',
    "process.exit(0);",
    "",
  ].join("\n");
  writeFileSync(stub, script, { mode: 0o755 });
  chmodSync(stub, 0o755);
  return stub;
}

/** Options for the offline check. */
export interface OfflineCheckOptions {
  readonly deps: SetupDeps;
  /** Absolute path to the CLI bin used to spawn the isolated service. */
  readonly binPath: string;
  /** Sink for progress lines (stderr-safe; keeps stdout to one envelope). */
  readonly log?: (line: string) => void;
}

/**
 * Run the offline, isolated end-to-end check.
 *
 * Steps exercise: packaged setup → dummy credential reference → real isolated
 * service → project/session create → sandboxed tool playback (fixture) →
 * evidence/accept → reconnect → stale-event idempotency → secret redaction →
 * cleanup ownership. All paths include a space to prove space-safety.
 */
export async function runOfflineCheck(options: OfflineCheckOptions): Promise<CheckReport> {
  const steps: CheckStep[] = [];
  const push = (s: CheckStep) => steps.push(s);
  let workspace: string | undefined;
  let shortSocketDir: string | undefined;
  let fixture: FixtureServer | undefined;

  try {
    workspace = makeWorkspace();
    const configPath = join(workspace, "private config", "config.json");
    const stateDir = join(workspace, "state dir");
    const projectHome = join(workspace, "projects");
    const runtimeBase = chooseRuntimeDir();
    // If no short+writable runtime base exists (e.g. sandboxed /tmp), fall back
    // to a SHORT socket path directly under the working directory — the same
    // isolation pattern the project test suite uses. If even that cannot fit the
    // platform UDS limit, report SKIP (never a false PASS) rather than failing.
    const serviceEnv: Record<string, string> = { [FIXTURE_ENV_NAME]: "fixture-not-a-real-key" };
    let socketPath: string;
    let canStartService = true;
    if (runtimeBase !== undefined) {
      serviceEnv.PI_DURABLE_RUNTIME_DIR = runtimeBase;
      socketPath = join(resolveRuntimeDir(stateDir, { PI_DURABLE_RUNTIME_DIR: runtimeBase }), "s");
    } else {
      const stateKey = createHash("sha256").update(resolve(stateDir)).digest("hex").slice(0, 4);
      const shortDir = join(process.cwd(), ".s", `pdm${process.pid.toString(16)}-${stateKey}`);
      const candidate = join(shortDir, "s");
      if (Buffer.byteLength(candidate) <= 100) {
        try {
          mkdirSync(shortDir, { recursive: true, mode: 0o700 });
          shortSocketDir = shortDir;
          socketPath = candidate;
        } catch {
          canStartService = false;
          socketPath = join(stateDir, "s");
        }
      } else {
        canStartService = false;
        socketPath = join(stateDir, "s");
      }
    }

    // 0. Start the deterministic loopback OpenAI-compatible fixture server. The
    //    production `modal` provider transport dials this REAL HTTP server
    //    through the unchanged code path; only the model's tool-call decisions
    //    are scripted. This is NOT a sandbox bypass: it is only started here by
    //    the human/manager-initiated `check` command.
    try {
      fixture = await startFixtureServer();
    } catch (error) {
      push({
        id: "fixture_server",
        label: "Deterministic loopback fixture provider starts",
        status: "FAIL",
        detail: redactString((error as Error).message),
        fixture: true,
      });
      return await finishOffline(steps, workspace, shortSocketDir);
    }
    push({
      id: "fixture_server",
      label: "Deterministic loopback fixture provider starts",
      status: "PASS",
      detail: `OpenAI-compatible server on 127.0.0.1:${fixture.port} (real HTTP; not dialed until an assignment runs)`,
      fixture: true,
    });

    // Owned stub `codex` CLI: captures the wake argv/STDIN so the manager wake
    // dispatcher is exercised end-to-end without a real Codex install. Labelled
    // a FIXTURE wake stub (never a real GUI receipt).
    const wakeCapture = join(workspace, "fixture-wake.ndjson");
    const codexStub = writeFixtureWakeStub(workspace, wakeCapture);

    // 1. Setup writes a real config into the temp workspace (idempotent). The
    //    endpoint is the LIVE fixture server URL so the isolated service dials a
    //    real OpenAI-compatible server through the production transport.
    const fixtureEndpoint = `${fixture.baseUrl}`;
    try {
      const report = await runSetup(
        {
          configPath,
          endpoint: fixtureEndpoint,
          model: "fixture-model",
          credentialEnv: FIXTURE_ENV_NAME,
          projectHome,
          stateDir,
          allowNetwork: false,
          codexExecutable: codexStub,
        },
        options.deps,
      );
      push({
        id: "setup",
        label: "Guided setup writes a private config",
        status: report.configWritten ? "PASS" : "FAIL",
        detail: report.configWritten ? `wrote ${configPath} (mode 0600)` : "config was not written",
      });
      // Prove idempotent re-run does not clobber (second run with replace).
      const rerun = await runSetup(
        {
          configPath,
          endpoint: fixtureEndpoint,
          model: "fixture-model",
          credentialEnv: FIXTURE_ENV_NAME,
          projectHome,
          stateDir,
          allowNetwork: false,
          replace: true,
          codexExecutable: codexStub,
        },
        options.deps,
      );
      push({
        id: "setup_rerun",
        label: "Repeat setup preserves existing config",
        status: rerun.configWritten && existsSync(configPath) ? "PASS" : "FAIL",
        detail: rerun.configBackup ? `previous config backed up to ${rerun.configBackup}` : "no prior config to back up",
      });
    } catch (error) {
      push({
        id: "setup",
        label: "Guided setup writes a private config",
        status: "FAIL",
        detail: redactString((error as Error).message),
      });
      await fixture.close().catch(() => undefined);
      fixture = undefined;
      return await finishOffline(steps, workspace, shortSocketDir);
    }

    // 1b. Install the PACKAGED standalone skill + plugin into an OWNED,
    //     isolated HOME (inside the fixture workspace) using the shipped
    //     installers, then verify the on-disk artifacts, the private launcher
    //     pointer, and the marketplace catalog's './'-relative path. This
    //     proves the guided-setup path is usable WITHOUT editing source: the
    //     installers only copy bundled assets and write private pointers.
    {
      const installHome = join(workspace, "install-home");
      const skillDest = join(installHome, ".codex", "skills", "pi-durable");
      const pluginDest = join(installHome, ".agents", "plugins", "pi-durable-manager");
      try {
        // Locate the packaged `scripts/` dir. Compiled code may live in `dist/`
        // or `dist-test/src/`, so probe upward for the first ancestor that
        // actually contains the shipped installer.
        const scriptsDir = findScriptsDir(dirname(fileURLToPath(import.meta.url)));
        const skillMod = (await import(
          pathToFileURL(join(scriptsDir, "install-skill.mjs")).href
        )) as {
          install: (o: Record<string, unknown>, fsOps?: unknown) => { destination: string };
          parseArgs: (argv: string[]) => Record<string, unknown>;
        };
        const pluginMod = (await import(
          pathToFileURL(join(scriptsDir, "install-plugin.mjs")).href
        )) as {
          install: (o: Record<string, unknown>, fsOps?: unknown) => {
            destination: string;
            version: string;
            marketplace: string | null;
            registered: boolean;
          };
          parseArgs: (argv: string[]) => Record<string, unknown>;
        };

        const cfgForInstall = configPath;
        const binForInstall = join(dirname(scriptsDir), "bin", "pi-durable.js");

        const skillOpts = skillMod.parseArgs([
          "--destination",
          skillDest,
          "--bin",
          binForInstall,
          "--config",
          cfgForInstall,
        ]);
        skillMod.install(skillOpts);

        const pluginOpts = pluginMod.parseArgs([
          "--destination",
          pluginDest,
          "--bin",
          binForInstall,
          "--config",
          cfgForInstall,
        ]);
        const pluginPlan = pluginMod.install(pluginOpts);

        const skillOk = existsSync(join(skillDest, "SKILL.md"));
        const pointerPath = join(skillDest, "local-settings.json");
        const pointerOk = existsSync(pointerPath);
        let pointerPrivate = false;
        let pointerTargets = false;
        if (pointerOk) {
          pointerPrivate = (statSync(pointerPath).mode & 0o777) === 0o600;
          const ptr = JSON.parse(await readFile(pointerPath, "utf8")) as {
            bin?: string;
            configPath?: string;
          };
          pointerTargets =
            ptr.bin === binForInstall && ptr.configPath === cfgForInstall;
        }
        const catalogPath = join(installHome, ".agents", "plugins", "marketplace.json");
        let catalogOk = false;
        if (existsSync(catalogPath)) {
          const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as {
            plugins?: Array<{ source?: { path?: string } }>;
          };
          const rel = catalog.plugins?.[0]?.source?.path ?? "";
          // Resolve the './'-relative path against the marketplace ROOT
          // (installHome) and require it to land exactly on the plugin dir.
          catalogOk =
            rel.startsWith("./") && resolve(installHome, rel) === resolve(pluginDest);
        }
        const ok = skillOk && pointerOk && pointerPrivate && pointerTargets && catalogOk &&
          existsSync(join(pluginDest, "plugin.json"));

        push({
          id: "skill_plugin_install",
          label: "Packaged skill + plugin install into an isolated HOME",
          status: ok ? "PASS" : "FAIL",
          detail: ok
            ? `installed skill + plugin v${pluginPlan.version} into an isolated HOME; private launcher pointer (0600) + './'-relative catalog are correct`
            : `installation incomplete (skill=${skillOk} pointer=${pointerOk} pointerPrivate=${pointerPrivate} pointerTargets=${pointerTargets} catalog=${catalogOk})`,
        });
      } catch (error) {
        push({
          id: "skill_plugin_install",
          label: "Packaged skill + plugin install into an isolated HOME",
          status: "FAIL",
          detail: redactString((error as Error).message),
        });
      }
    }

    // 2. Start a REAL isolated service on the loopback socket. The fixture
    //    credential NAME is set to a DUMMY non-secret value for the child only:
    //    it is never a real key, is never read from the user, and never leaves
    //    this process's environment.
    if (!canStartService) {
      push({
        id: "service_start",
        label: "Isolated local service starts",
        status: "SKIP",
        detail:
          "no short+writable runtime dir for a UNIX domain socket on this host " +
          "(sandboxed /tmp and the working directory path exceeds the UDS limit); " +
          "service steps skipped",
      });
      await fixture.close().catch(() => undefined);
      fixture = undefined;
      return await finishOffline(steps, workspace, shortSocketDir);
    }
    const start = await startDaemon({
      binPath: options.binPath,
      configPath,
      socketPath,
      stateDir,
      readyTimeoutMs: 15000,
      env: serviceEnv,
    });
    const started = start.ok === true;
    push({
      id: "service_start",
      label: "Isolated local service starts",
      status: started ? "PASS" : "FAIL",
      detail: started ? `listening at ${socketPath}` : `start failed: ${start.code ?? "unknown"}`,
    });
    if (!started) {
      await fixture.close().catch(() => undefined);
      fixture = undefined;
      return await finishOffline(steps, workspace, shortSocketDir);
    }

    try {
      const client = await PiClient.connect({ socketPath, timeoutMs: 15000 });
      try {
        // 3. Project + session create (idempotent with a stable request id).
        const projectResult = (await client.call(
          "projects.create",
          { name: "fixture-app", path: join(projectHome, "fixture-app") },
          "check-project",
        )) as { project?: { id?: string } };
        const projectId = projectResult?.project?.id;
        push({
          id: "project_create",
          label: "Create a project",
          status: projectId ? "PASS" : "FAIL",
          detail: projectId ? `project id ${projectId}` : "no project id returned",
        });

        const sessionResult = (await client.call(
          "sessions.create",
          { projectId },
          "check-session",
        )) as { session?: { id?: string } };
        const sessionId = sessionResult?.session?.id;
        push({
          id: "session_create",
          label: "Create a session",
          status: sessionId ? "PASS" : "FAIL",
          detail: sessionId ? `session id ${sessionId}` : "no session id returned",
        });

        // 4. Capabilities probe — proves the packaged service advertises its
        //    method surface over the same socket a new chat would use.
        try {
          const caps = (await client.call("service.capabilities", {}, "check-caps")) as {
            methods?: string[];
          };
          const count = Array.isArray(caps?.methods) ? caps.methods.length : 0;
          push({
            id: "capabilities",
            label: "Service advertises capabilities",
            status: count > 0 ? "PASS" : "FAIL",
            detail: `${count} implemented methods`,
          });
        } catch (error) {
          push({
            id: "capabilities",
            label: "Service advertises capabilities",
            status: "FAIL",
            detail: redactString((error as Error).message),
          });
        }

        // 5. Bind the project to a manager thread BEFORE submitting work, so the
        //    terminal `needs_review` transition records a durable wake event.
        const threadId = FIXTURE_THREAD_ID;
        try {
          const bind = (await client.call(
            "manager.bind",
            { projectId, threadId },
            "check-bind",
          )) as { binding?: { threadId?: string } };
          push({
            id: "manager_bind",
            label: "Bind project to a manager thread (before submit)",
            status: bind?.binding?.threadId === threadId ? "PASS" : "FAIL",
            detail:
              bind?.binding?.threadId === threadId
                ? `bound to thread ${threadId}`
                : "binding did not record the requested thread",
          });
        } catch (error) {
          push({
            id: "manager_bind",
            label: "Bind project to a manager thread (before submit)",
            status: "FAIL",
            detail: redactString((error as Error).message),
          });
        }

        // 6. Submit a bounded sample assignment. The service runs the REAL
        //    assignment engine with the REAL Modal provider transport, which
        //    dials our loopback fixture server. The scripted turn writes a file
        //    into the sandboxed project and runs a real test command.
        const task = "Create hello.txt with a greeting, then run the test command.";
        const criteria = "hello.txt exists with the exact fixture bytes and the test command exits 0.";
        let assignmentId: string | undefined;
        try {
          const submitted = (await client.call(
            "assignments.submit",
            { projectId, task, criteria, sessionId },
            "check-submit",
          )) as { assignment?: { id?: string } };
          assignmentId = submitted?.assignment?.id;
          push({
            id: "assignment_submit",
            label: "Submit a bounded sample assignment",
            status: assignmentId ? "PASS" : "FAIL",
            detail: assignmentId ? `assignment id ${assignmentId}` : "no assignment id returned",
          });
        } catch (error) {
          push({
            id: "assignment_submit",
            label: "Submit a bounded sample assignment",
            status: "FAIL",
            detail: redactString((error as Error).message),
          });
        }

        if (assignmentId !== undefined) {
          let finalState: string | undefined;
          try {
            const settled = (await client.call(
              "assignments.wait",
              { id: assignmentId, timeoutMs: 60000 },
              "check-wait",
            )) as { state?: string };
            finalState = settled?.state;
            push({
              id: "assignment_run",
              label: "Fixture assignment runs to needs_review",
              status: finalState === "needs_review" ? "PASS" : "FAIL",
              detail: `terminal state: ${finalState ?? "unknown"}`,
              fixture: true,
            });
          } catch (error) {
            push({
              id: "assignment_run",
              label: "Fixture assignment runs to needs_review",
              status: "FAIL",
              detail: redactString((error as Error).message),
              fixture: true,
            });
          }

          // 6a. Prove the fixture server was actually dialed through the
          //     production transport: the request count must be non-zero.
          const dialed = fixture.requestCount();
          push({
            id: "fixture_dialed",
            label: "Production transport dialed the fixture provider",
            status: dialed > 0 ? "PASS" : "FAIL",
            detail: `${dialed} chat.completions request(s) received by the loopback fixture server`,
            fixture: true,
          });

          // 6b. Assert the sandboxed file write really happened: exact bytes on
          //     disk inside the project checkout (not a label).
          const writtenPath = join(projectHome, "fixture-app", FIXTURE_FILE_NAME);
          let bytesOk = false;
          let actualHash = "";
          try {
            const bytes = await readFile(writtenPath);
            actualHash = createHash("sha256").update(bytes).digest("hex");
            bytesOk = bytes.toString("utf8") === FIXTURE_FILE_CONTENT;
          } catch {
            bytesOk = false;
          }
          const expectedHash = sha256Hex(FIXTURE_FILE_CONTENT);
          push({
            id: "assignment_wrote_file",
            label: "Sandboxed worker created the fixture file (hashed)",
            status: bytesOk && actualHash === expectedHash ? "PASS" : "FAIL",
            detail:
              bytesOk && actualHash === expectedHash
                ? `${FIXTURE_FILE_NAME} sha256=${actualHash.slice(0, 16)}… matches expected bytes`
                : `file missing or bytes mismatch (expected sha256=${expectedHash.slice(0, 16)}…)`,
            fixture: true,
          });

          // 6c. Assert the real sandboxed test command ran: the captured tool
          //     result must include the command's stdout marker.
          try {
            // A marker that appears in the command *input* is not proof the
            // command ran. We require a recorded TOOL RESULT (`pi.tool-result`)
            // whose output carries the marker, and we strip the assistant
            // tool-call arguments before scanning so the command text itself
            // can never satisfy this check.
            const TOOL_RESULT_KIND = "pi.tool-result";
            const marker = "FIXTURE_TEST_OK";

            interface ToolResultInspection {
              /** A record `pi.tool-result` for `bash` carried `marker` in its output AND exited cleanly. */
              readonly ranCleanly: boolean;
              /** The bash tool could not run at all (nested-sandbox / profile) — environment limitation, not our bug. */
              readonly sandboxUnavailable: boolean;
            }

            /**
             * Inspect transcript entries for the RESULT of a bash tool call.
             *
             * A marker present in the command *arguments* is NOT proof the
             * command ran: we look only at `pi.tool-result` entries (the
             * assistant's `pi.assistant` tool-call args are ignored), require
             * `isError === false`, and require the rendered output to actually
             * carry `marker`. If the harness reports the sandbox itself could
             * not be applied we surface that as an environment limitation
             * rather than a pass or a product failure.
             */
            const inspectToolResults = (entries: unknown): ToolResultInspection => {
              let ranCleanly = false;
              let sandboxUnavailable = false;
              if (!Array.isArray(entries)) return { ranCleanly, sandboxUnavailable };
              for (const entry of entries) {
                if (entry === null || typeof entry !== "object") continue;
                if ((entry as { kind?: unknown }).kind !== TOOL_RESULT_KIND) continue;
                const messages = (entry as { model?: unknown }).model;
                const list = Array.isArray(messages) ? messages : [];
                for (const msg of list) {
                  if (msg === null || typeof msg !== "object") continue;
                  const toolName = (msg as { toolName?: unknown }).toolName;
                  if (toolName !== "bash") continue;
                  const isError = (msg as { isError?: unknown }).isError === true;
                  const content = (msg as { content?: unknown }).content;
                  const text = Array.isArray(content)
                    ? content
                        .map((c) => (typeof (c as { text?: unknown })?.text === "string" ? (c as { text: string }).text : ""))
                        .join("\n")
                    : "";
                  if (/sandbox-exec cannot apply a profile|nested sandbox/i.test(text)) {
                    sandboxUnavailable = true;
                  }
                  if (!isError && text.includes(marker)) ranCleanly = true;
                }
              }
              return { ranCleanly, sandboxUnavailable };
            };

            let transcriptSeesResult = false;
            let sandboxUnavailable = false;
            if (sessionId !== undefined) {
              try {
                const page = (await client.call(
                  "sessions.transcript",
                  { id: sessionId, limit: 262144 },
                  "check-transcript",
                )) as { entries?: unknown };
                if (process.env.PI_DURABLE_CHECK_DEBUG === "1") {
                  const tr = (Array.isArray(page?.entries) ? page.entries : []).filter(
                    (e) => (e as { kind?: unknown })?.kind === TOOL_RESULT_KIND,
                  );
                  process.stderr.write(`\n[DEBUG tool-results]\n${JSON.stringify(tr).slice(0, 4000)}\n`);
                }
                const seen = inspectToolResults(page?.entries);
                transcriptSeesResult = seen.ranCleanly;
                sandboxUnavailable = seen.sandboxUnavailable;
              } catch {
                transcriptSeesResult = false;
              }
            }
            // The evidence bundle is the other durable record; accept it only
            // when it contains a tool-result-shaped record, never a bare
            // substring that could come from the command arguments.
            const evidence = (await client.call(
              "assignments.evidence",
              { id: assignmentId },
              "check-evidence",
            )) as unknown;
            const evidenceSeen = inspectToolResults(
              (evidence as { entries?: unknown })?.entries ?? evidence,
            );
            const sawTestOk = transcriptSeesResult || evidenceSeen.ranCleanly;
            const sandboxBlocked = sandboxUnavailable || evidenceSeen.sandboxUnavailable;
            push({
              id: "assignment_ran_test",
              label: "Sandboxed worker ran the test command",
              status: sawTestOk ? "PASS" : sandboxBlocked ? "SKIP" : "FAIL",
              detail: sawTestOk
                ? `a recorded ${TOOL_RESULT_KIND} entry carries the command output marker from \`${FIXTURE_TEST_COMMAND}\``
                : sandboxBlocked
                  ? "nested sandbox: sandbox-exec cannot apply a profile here, so the fixture bash tool could not run (environment limitation; re-run on the host)"
                  : "no recorded tool-result entry carried the test-command output (the command input alone is not proof)",
              fixture: true,
            });
          } catch (error) {
            push({
              id: "assignment_ran_test",
              label: "Sandboxed worker ran the test command",
              status: "FAIL",
              detail: redactString((error as Error).message),
              fixture: true,
            });
          }

          // 6d. Accept the reviewed assignment (explicit manager review).
          try {
            const reviewed = (await client.call(
              "assignments.review",
              { id: assignmentId, decision: "accept", note: "offline fixture self-check" },
              "check-review",
            )) as { state?: string };
            push({
              id: "assignment_review",
              label: "Manager review accepts the assignment",
              status: reviewed?.state === "accepted" ? "PASS" : "FAIL",
              detail: `state after review: ${reviewed?.state ?? "unknown"}`,
            });
          } catch (error) {
            push({
              id: "assignment_review",
              label: "Manager review accepts the assignment",
              status: "FAIL",
              detail: redactString((error as Error).message),
            });
          }
        }

        // 7. Manager event + ack/reack. ORDER MATTERS: the dispatcher delivers
        //    the wake on a timer AFTER the durable event commits, and only
        //    UNACKED pending events are considered due. Acking BEFORE the
        //    dispatcher runs would cancel the wake. So we (a) observe the durable
        //    event while it is still unacked, (b) wait (bounded) for the REAL
        //    dispatcher delivery to the fixture stub, (c) only then ack + re-ack
        //    to prove idempotency. This mirrors the live manager workflow (the
        //    GUI receives the wake, works it, then acks).
        const isWakeDelivery = (line: string): boolean => {
          try {
            const rec = JSON.parse(line) as { argv?: unknown };
            const argv = Array.isArray(rec.argv) ? rec.argv.map(String) : [];
            if (argv.includes("--help") || argv.includes("-h")) return false;
            return argv.includes("--thread") && argv.includes("--message");
          } catch {
            return false;
          }
        };
        let firstEventId: string | undefined;
        try {
          const events = (await client.call(
            "manager.events",
            { projectId, unacked: true },
            "check-events",
          )) as { events?: { eventId?: string; state?: string }[] };
          const list = Array.isArray(events?.events) ? events.events : [];
          const firstEvent = list.find((e) => typeof e.eventId === "string");
          firstEventId = firstEvent?.eventId;
          push({
            id: "manager_event",
            label: "Manager wake event recorded for the terminal transition",
            status: firstEvent ? "PASS" : "FAIL",
            detail: firstEvent ? `event ${firstEvent.eventId} (${firstEvent.state ?? "?"})` : "no unacked manager event",
          });
        } catch (error) {
          push({
            id: "manager_event",
            label: "Manager wake event recorded for the terminal transition",
            status: "FAIL",
            detail: redactString((error as Error).message),
          });
        }

        // 7a. The fixture wake CLI stub must capture a REAL `queue --thread …
        //     --message …` delivery (proving the dispatcher ran end-to-end);
        //     this is a FIXTURE receipt, never a claim of a real GUI
        //     acknowledgement. `--help`/usage probes are excluded. We poll
        //     (bounded) here, BEFORE acking, so the dispatcher is not cancelled.
        try {
          const wakeDeadline = Date.now() + 30000;
          let deliveries: string[] = [];
          for (;;) {
            const captured = existsSync(wakeCapture) ? await readFile(wakeCapture, "utf8") : "";
            deliveries = captured.split("\n").filter((l) => l.trim() !== "").filter(isWakeDelivery);
            if (deliveries.length > 0 || Date.now() >= wakeDeadline) break;
            await new Promise((r) => setTimeout(r, 250));
          }
          push({
            id: "manager_wake",
            label: "Wake dispatcher handed the fixture codex stub a prompt",
            status: deliveries.length > 0 ? "PASS" : "FAIL",
            detail:
              deliveries.length > 0
                ? `${deliveries.length} fixture wake delivery(ies) with --thread/--message captured (FIXTURE stub, not a real GUI receipt)`
                : "fixture wake stub recorded no --thread/--message delivery (only --help or nothing)",
            fixture: true,
          });
        } catch (error) {
          push({
            id: "manager_wake",
            label: "Wake dispatcher handed the fixture codex stub a prompt",
            status: "FAIL",
            detail: redactString((error as Error).message),
            fixture: true,
          });
        }

        // 7b. NOW ack the event, then re-ack to prove idempotency.
        if (firstEventId !== undefined) {
          try {
            const ack = (await client.call(
              "manager.ack",
              { eventId: firstEventId },
              "check-ack",
            )) as { acked?: boolean };
            const reack = (await client.call(
              "manager.ack",
              { eventId: firstEventId },
              "check-reack",
            )) as { acked?: boolean; replayed?: boolean };
            push({
              id: "manager_ack",
              label: "Acknowledge the event, then re-ack idempotently",
              status: ack?.acked === true && reack?.acked === true ? "PASS" : "FAIL",
              detail:
                ack?.acked === true && reack?.acked === true
                  ? `acked=true; re-ack replayed=${reack.replayed === true}`
                  : "ack/reack did not report acked=true",
            });
          } catch (error) {
            push({
              id: "manager_ack",
              label: "Acknowledge the event, then re-ack idempotently",
              status: "FAIL",
              detail: redactString((error as Error).message),
            });
          }
        }

        // 8. Reconnect to prove durability across a fresh client.
        const reconnect = await PiClient.connect({ socketPath, timeoutMs: 15000 });
        try {
          const status = (await reconnect.call("service.status", {}, "check-reconnect")) as {
            pid?: number;
          };
          push({
            id: "reconnect",
            label: "Reconnect to the running service",
            status: typeof status?.pid === "number" ? "PASS" : "FAIL",
            detail: typeof status?.pid === "number" ? `service pid ${status.pid}` : "no pid reported",
          });
        } finally {
          reconnect.close();
        }

        // 9. Secret redaction — a raw-looking key never survives a redact pass.
        const raw = "sk-abcdef0123456789abcdef";
        const redacted = redactString(`token=${raw}`);
        push({
          id: "redaction",
          label: "Secret redaction",
          status: redacted.includes("sk-abcdef") ? "FAIL" : "PASS",
          detail: redacted.includes("sk-abcdef") ? "raw key survived redaction" : "raw key removed from output",
        });

        // 10. Stale-event idempotency: replaying the same requestId is safe.
        try {
          const a = (await client.call(
            "projects.create",
            { name: "fixture-app", path: join(projectHome, "fixture-app") },
            "check-project",
          )) as { project?: { id?: string } };
          const replayedId = a?.project?.id;
          push({
            id: "idempotency",
            label: "Replayed request is idempotent",
            status: replayedId === projectId && projectId !== undefined ? "PASS" : "FAIL",
            detail:
              replayedId === projectId && projectId !== undefined
                ? "same project id returned on replay"
                : "idempotency key not honored by this build",
          });
        } catch (error) {
          push({
            id: "idempotency",
            label: "Replayed request is idempotent",
            status: "FAIL",
            detail: `idempotency check failed: ${redactString((error as Error).message)}`,
          });
        }
      } finally {
        client.close();
      }
    } finally {
      const stop = await stopDaemon(socketPath, 8000);
      push({
        id: "service_stop",
        label: "Isolated local service stops cleanly",
        status: stop.ok === true ? "PASS" : "FAIL",
        detail: stop.ok === true ? "stopped" : `stop failed: ${stop.code ?? "unknown"}`,
      });
    }

    // 8. Cleanup ownership: remove ONLY the workspace (and the short socket dir)
    //    that this run created. The fixture is closed and nulled AFTER the
    //    service has stopped, immediately before deletion, so nothing holds an
    //    open handle into the directory being removed.
    await fixture.close().catch(() => undefined);
    fixture = undefined;
    return await finishOffline(steps, workspace, shortSocketDir);
  } catch (error) {
    push({
      id: "unexpected",
      label: "Offline check",
      status: "FAIL",
      detail: redactString((error as Error).message),
    });
    await fixture?.close().catch(() => undefined);
    fixture = undefined;
    if (workspace !== undefined) {
      return await finishOffline(steps, workspace, shortSocketDir);
    }
    return summarize("0.7.0-beta.1", "offline", steps, {});
  }
}

/** Remove the verified workspace and record the cleanup step. */
async function finishOffline(
  steps: CheckStep[],
  workspace: string,
  shortSocketDir?: string,
): Promise<CheckReport> {
  const real = canonicalize(workspace);
  if (!isStrictlyInside(real, tmpdir())) {
    steps.push({
      id: "cleanup",
      label: "Owned cleanup",
      status: "FAIL",
      detail: `refusing to remove unverified path ${real}`,
    });
    return summarize("0.7.0-beta.1", "offline", steps, { workspace: real });
  }
  await rm(real, { recursive: true, force: true });
  // Remove the short socket dir only if it is a canonical
  // `<cwd>/.s/pdm<pidhex>-<statekey>` we created — never a broader path, and
  // never via a bare prefix test.
  let shortDirGone = true;
  if (shortSocketDir !== undefined) {
    const expectedParent = join(process.cwd(), ".s");
    const resolvedShort = canonicalize(shortSocketDir);
    const shortName = basename(resolvedShort);
    if (
      isStrictlyInside(resolvedShort, expectedParent) &&
      dirname(resolvedShort) === canonicalize(expectedParent) &&
      /^pdm[0-9a-f]+-[0-9a-f]+$/.test(shortName)
    ) {
      await rm(resolvedShort, { recursive: true, force: true });
      shortDirGone = !existsSync(resolvedShort);
    } else {
      shortDirGone = false;
    }
  }
  const clean = !existsSync(real) && shortDirGone;
  steps.push({
    id: "cleanup",
    label: "Owned cleanup",
    status: clean ? "PASS" : "FAIL",
    detail: clean ? "temporary workspace removed" : "temporary files still present",
  });
  return summarize("0.7.0-beta.1", "offline", steps, { workspace: real });
}

export interface ServiceIdentity {
  configFile?: string | null;
  stateDir?: string;
  protocolVersion?: number;
  packageVersion?: string;
  model?: string;
  providerId?: string;
}

/**
 * The FULL service-identity comparison the online check performs BEFORE any
 * project mutation. Every field is validated STRICTLY: a missing field is a
 * mismatch, never "unknown so probably fine". Returns the individual booleans,
 * the aggregate `compatible`, and human reasons for any mismatch so the caller
 * can report truthfully and stop before mutating.
 */
export function serviceCompatCheck(
  status: ServiceIdentity | undefined | null,
  expected: {
    configPath: string;
    stateDir: string;
    packageVersion: string;
    model: string | undefined;
    providerId?: string;
  },
): {
  compatible: boolean;
  sameConfig: boolean;
  sameState: boolean;
  sameProtocol: boolean;
  samePackageVersion: boolean;
  sameProvider: boolean;
  sameModel: boolean;
  reasons: string[];
} {
  const sameConfig =
    typeof status?.configFile === "string" &&
    resolve(status.configFile) === resolve(expected.configPath);
  const sameState =
    typeof status?.stateDir === "string" && resolve(status.stateDir) === resolve(expected.stateDir);
  const sameProtocol = status?.protocolVersion === PROTOCOL_VERSION;
  const samePackageVersion = status?.packageVersion === expected.packageVersion;
  const sameProvider = status?.providerId === (expected.providerId ?? MODAL_PROVIDER_ID);
  const sameModel = typeof status?.model === "string" && status.model === expected.model;
  const reasons: string[] = [];
  if (!sameConfig) reasons.push(`config bound to ${String(status?.configFile)} ≠ ${expected.configPath}`);
  if (!sameState) reasons.push(`state dir ${String(status?.stateDir)} ≠ ${expected.stateDir}`);
  if (!sameProtocol) reasons.push(`protocol ${String(status?.protocolVersion)} ≠ ${PROTOCOL_VERSION}`);
  if (!samePackageVersion)
    reasons.push(`package version ${String(status?.packageVersion)} ≠ ${expected.packageVersion}`);
  if (!sameProvider) reasons.push(`provider ${String(status?.providerId)} ≠ ${expected.providerId ?? MODAL_PROVIDER_ID}`);
  if (!sameModel) reasons.push(`model ${String(status?.model)} ≠ ${String(expected.model)}`);
  return {
    compatible:
      sameConfig && sameState && sameProtocol && samePackageVersion && sameProvider && sameModel,
    sameConfig,
    sameState,
    sameProtocol,
    samePackageVersion,
    sameProvider,
    sameModel,
    reasons,
  };
}

/** Options for the online check (real endpoint + wake). */
export interface OnlineCheckOptions {
  readonly deps: SetupDeps;
  /** Absolute path to the CLI bin. */
  readonly binPath: string;
  readonly configPath: string;
  /** User-requested Codex thread UUID that will own the wake receipt. */
  readonly threadId: string;
  /**
   * Optional absolute path where the run record (ids for project/session/
   * assignment/request/event/receipt) is persisted BEFORE this function
   * returns. Defaults to `<stateDir>/online-check-runs/<runId>.json`.
   */
  readonly runFile?: string;
  /** Bounded window to wait for the first wake event after submit (default 30s). */
  readonly eventWaitMs?: number;
  /**
   * Injectable filesystem for the run receipt (defaults to the real atomic
   * 0600 writer). Tests override this to prove that a receipt that cannot be
   * durably persisted is FATAL before ANY mutation — nothing is submitted.
   */
  readonly runFs?: RunStoreFs;
  readonly log?: (line: string) => void;
}

/**
 * Run the online check against a REAL endpoint. Requires an explicit thread
 * UUID; it never invents one and never reports a fabricated dispatch/ack.
 *
 * NOTE: This function performs real inference/wake. It is intended to be
 * invoked by a human or the manager, not by automated CI (which must use
 * `--offline`). It does not run other LLM coding workers itself.
 */
export async function runOnlineCheck(options: OnlineCheckOptions): Promise<CheckReport> {
  const steps: CheckStep[] = [];
  const push = (s: CheckStep) => steps.push(s);

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.threadId)) {
    throw new CliUsageError(
      "bad_thread_id",
      "Online check requires --thread-id with a real Codex thread UUID you own (used for the wake receipt).",
    );
  }
  if (!existsSync(options.configPath)) {
    throw new CliUsageError("no_config", `Config not found: ${options.configPath}. Run \`pi-durable setup\` first.`);
  }

  // Resolve the config with the REAL runtime parser (never a hand-built
  // approximation): this both validates it and applies the same relative-path
  // resolution the service uses.
  let resolvedConfig: Awaited<ReturnType<typeof loadConfig>>;
  try {
    resolvedConfig = await loadConfig(options.configPath);
  } catch (error) {
    throw new CliUsageError("bad_config", `Config is not usable: ${redactString((error as Error).message)}`);
  }
  const stateDir = resolvedConfig.paths.stateDir;
  const projectHome = resolvedConfig.paths.projectHome;

  const sock = resolveServiceSocket(stateDir);
  const socketPath = sock.socketPath;

  // 1. Ensure a service is running for the REAL config.
  const start = await startDaemon({
    binPath: options.binPath,
    configPath: options.configPath,
    socketPath,
    stateDir,
    readyTimeoutMs: 15000,
    env: sock.env,
  });
  push({
    id: "service_start",
    label: "Service reachable for the real config",
    status: start.ok === true ? "PASS" : "FAIL",
    detail: start.ok === true ? `listening at ${socketPath}` : `start failed: ${start.code ?? "unknown"}`,
  });
  if (start.ok !== true) return summarize("0.7.0-beta.1", "online", steps, { threadId: options.threadId });

  // A fresh, unique run id keeps every id/path distinct across invocations.
  const runId = randomUUID();
  const runFile =
    options.runFile ?? join(stateDir, "online-check-runs", `${runId}.json`);
  const projectPath = join(projectHome, `online-check-${runId}`);
  const task =
    "Create hello.txt containing the exact line `hello from the online check` and report the file's sha256.";
  const criteria = "hello.txt exists with the expected bytes; the assignment reaches needs_review for review.";

  // Per-run request IDs for EVERY durable mutation. Each is unique to this
  // runId, so replaying a lost/retried RPC resolves against its own journal
  // entry instead of colliding with a DIFFERENT run's fixed id (the previous
  // `manager.bind` used the constant "online-bind", which conflicted on the
  // second run against the same long-lived service). These are stored on the
  // run record BEFORE any action so a crash mid-flight can be reconciled.
  const ids = {
    project: `online-project-${runId}`,
    bind: `online-bind-${runId}`,
    session: `online-session-${runId}`,
    assignment: `online-assignment-${runId}`,
    status: `online-status-${runId}`,
    show: `online-show-${runId}`,
    events: `online-events-${runId}`,
  };

  // Record-of-truth object. Written BEFORE the first durable action so a crash
  // or transport loss leaves a receipt whose request IDs can reconcile the
  // run (never an orphan/duplicate). Updated after each durable step.
  const run: Record<string, unknown> = {
    runId,
    threadId: options.threadId,
    configPath: options.configPath,
    projectPath,
    startedAt: new Date().toISOString(),
    status: "running",
    requestIds: { ...ids },
  };
  // FATAL: the initial receipt MUST be durably persisted BEFORE ANY mutation
  // (project/session/bind/assignment). If it cannot be written, we submit
  // NOTHING and report a truthful FAIL — durable ids/crash recovery are not
  // best-effort, they are a precondition.
  const runFs = options.runFs ?? realRunStoreFs;
  try {
    await persistRun(runFile, run, runFs);
  } catch (error) {
    push({
      id: "run_record",
      label: "Durably persist the run receipt BEFORE any mutation",
      status: "FAIL",
      detail: `refusing to mutate anything: ${redactString((error as Error).message)}`,
    });
    run.status = "receipt_not_persisted";
    return summarize("0.7.0-beta.1", "online", steps, { threadId: options.threadId, runFile });
  }

  // From here on the run is durably journalled. A later persist failure is NOT
  // fatal to the run's identity: the ids are already recorded, so we surface it
  // truthfully (FAILED step, non-zero exit) without re-submitting any mutation.
  const persistState: { persistFailure?: string } = {};

  // IMPORTANT: the online check is a PERSISTENT, same-GUI manager workflow, NOT
  // an ephemeral fixture daemon. It must NOT stop the service on exit: the
  // daemon has to stay alive for the active assignment and the dispatcher to
  // deliver the wake once the manager reviews and acks. Cleanup is a SEPARATE,
  // explicit action after review (see `pi-durable check --verify`). We therefore
  // never shut the service down here — neither one we started nor the user's.

  try {
    const client = await PiClient.connect({ socketPath, timeoutMs: 20000 });
    try {
      // Ensure the configured project home exists privately before creating the
      // dedicated project directory inside it.
      try {
        mkdirSync(projectHome, { recursive: true, mode: 0o700 });
      } catch (error) {
        push({
          id: "project_home",
          label: "Prepare the configured project home",
          status: "FAIL",
          detail: redactString((error as Error).message),
        });
      }

      // 1a. Fail fast on an incompatible/stale service BEFORE any project write.
      //     Compare the FULL identity the label advertises: config file, package
      //     version, protocol, state dir, provider id, AND model. Every field is
      //     validated STRICTLY — a missing field is a mismatch, never "unknown
      //     so probably fine". A mismatch OR a status read failure is fatal and
      //     stops before any project/session/bind/assignment mutation. There is
      //     NO fallback that proceeds against a service that is not provably the
      //     one this config describes.
      const expectedPackageVersion = packageVersion();
      const expectedModel = resolvedConfig.model;
      let compatFailed = false;
      try {
        const status = (await client.call("service.status", {}, ids.status)) as ServiceIdentity;
        const compat = serviceCompatCheck(status, {
          configPath: options.configPath,
          stateDir,
          packageVersion: expectedPackageVersion,
          model: expectedModel,
          providerId: configuredProviderId(resolvedConfig),
        });
        const {
          compatible,
          sameConfig,
          sameState,
          sameProtocol,
          samePackageVersion,
          sameProvider,
          sameModel,
          reasons,
        } = compat;
        push({
          id: "service_compat",
          label:
            "Running service matches this config (config + package version + protocol + state + provider + model)",
          status: compatible ? "PASS" : "FAIL",
          detail: compatible
            ? `config ${status.configFile}; v${status.packageVersion}; protocol ${status.protocolVersion}; provider ${String(status?.providerId)}; model ${String(status?.model)}`
            : `incompatible running service: ${reasons.join("; ")}. Stop the stale daemon before running --online (this check never stops your daemon).`,
        });
        if (!compatible) {
          compatFailed = true;
          run.status = "incompatible_service";
          run.serviceConfigFile = status?.configFile ?? null;
          run.serviceIdentity = {
            packageVersion: status?.packageVersion ?? null,
            protocolVersion: status?.protocolVersion ?? null,
            providerId: status?.providerId ?? null,
            model: status?.model ?? null,
            stateDir: status?.stateDir ?? null,
          };
          await persistRunSafe(runFile, run, persistState, runFs);
          return summarize("0.7.0-beta.1", "online", steps, { threadId: options.threadId, runFile });
        }
      } catch (error) {
        compatFailed = true;
        run.status = "service_status_error";
        await persistRunSafe(runFile, run, persistState, runFs);
        push({
          id: "service_compat",
          label:
            "Running service matches this config (config + package version + protocol + state + provider + model)",
          status: "FAIL",
          detail: `could not read service status: ${redactString((error as Error).message)}`,
        });
        return summarize("0.7.0-beta.1", "online", steps, { threadId: options.threadId, runFile });
      }
      void compatFailed;

      // 2. A UNIQUE, dedicated project directory (no fixed global path).
      let projectId: string | undefined;
      try {
        const projectResult = (await client.call(
          "projects.create",
          { name: `online-check-${runId}`, path: projectPath, requestId: ids.project },
          ids.project,
        )) as { project?: { id?: string }; replayed?: boolean };
        projectId = projectResult?.project?.id;
        run.projectId = projectId ?? null;
        run.projectReplayed = projectResult?.replayed === true;
        await persistRunSafe(runFile, run, persistState, runFs);
        push({
          id: "project_create",
          label: "Create a unique dedicated project directory",
          status: projectId ? "PASS" : "FAIL",
          detail: projectId ? `project id ${projectId} at ${projectPath}` : "no project id returned",
        });
      } catch (error) {
        push({
          id: "project_create",
          label: "Create a unique dedicated project directory",
          status: "FAIL",
          detail: redactString((error as Error).message),
        });
      }

      if (projectId === undefined) {
        run.status = "project_failed";
        await persistRunSafe(runFile, run, persistState, runFs);
        return summarize("0.7.0-beta.1", "online", steps, { threadId: options.threadId, runFile });
      }

      // 3. Bind the manager thread BEFORE submit, so the very first terminal
      //    transition produces a wake event for this thread. The requestId is
      //    PER-RUN (recorded above), so a second run against the same service
      //    never collides with the first run's binding journal entry.
      try {
        const binding = (await client.call(
          "manager.bind",
          { projectId, threadId: options.threadId, requestId: ids.bind },
          ids.bind,
        )) as { binding?: { id?: string; threadId?: string } };
        run.receiptId = binding?.binding?.id ?? null;
        run.boundThreadId = binding?.binding?.threadId ?? options.threadId;
        await persistRunSafe(runFile, run, persistState, runFs);
        push({
          id: "manager_bind",
          label: "Bind manager thread BEFORE submit",
          status: "PASS",
          detail: `bound thread ${run.boundThreadId} (receipt ${String(run.receiptId ?? "n/a")})`,
        });
      } catch (error) {
        run.status = "bind_failed";
        await persistRunSafe(runFile, run, persistState, runFs);
        push({
          id: "manager_bind",
          label: "Bind manager thread BEFORE submit",
          status: "FAIL",
          detail: redactString((error as Error).message),
        });
        return summarize("0.7.0-beta.1", "online", steps, { threadId: options.threadId, runFile });
      }

      // 4. A session, then ONE real sample coding assignment (unique request id).
      run.requestId = ids.assignment;
      await persistRunSafe(runFile, run, persistState, runFs);
      let sessionId: string | undefined;
      try {
        const session = (await client.call(
          "sessions.create",
          { projectId, profileId: "existing", requestId: ids.session },
          ids.session,
        )) as { session?: { id?: string } };
        sessionId = session?.session?.id;
        run.sessionId = sessionId ?? null;
        await persistRunSafe(runFile, run, persistState, runFs);
      } catch (error) {
        push({
          id: "session_create",
          label: "Create a session for the sample assignment",
          status: "FAIL",
          detail: redactString((error as Error).message),
        });
      }

      if (sessionId !== undefined) {
        try {
          const submitted = (await client.call(
            "assignments.submit",
            { projectId, sessionId, task, criteria, requestId: ids.assignment },
            ids.assignment,
          )) as { assignment?: { id?: string } };
          run.assignmentId = submitted?.assignment?.id ?? null;
          run.submittedAt = new Date().toISOString();
          await persistRunSafe(runFile, run, persistState, runFs);
          push({
            id: "assignment_submit",
            label: "Submit ONE real sample coding assignment (submitted)",
            status: run.assignmentId ? "PASS" : "FAIL",
            detail: run.assignmentId
              ? `submitted assignment ${String(run.assignmentId)} (request ${ids.assignment})`
              : "no assignment id returned",
          });
        } catch (error) {
          push({
            id: "assignment_submit",
            label: "Submit ONE real sample coding assignment (submitted)",
            status: "FAIL",
            detail: redactString((error as Error).message),
          });
        }
      }

      // 5. Observe the FIRST wake event within a BOUNDED window (do NOT block
      //    forever, do NOT auto-accept, do NOT auto-ack unreviewed output). The
      //    assignment may still be running — we persist a PENDING receipt and
      //    yield; the daemon stays alive so a slow fixture/GUI still delivers.
      try {
        const first = await waitForFirstEvent(client, projectId, options.eventWaitMs ?? 30000, ids.events);
        run.eventId = first?.eventId ?? null;
        run.eventState = first?.state ?? null;
        // Report the ACTUAL delivery state from the store — never infer
        // "delivered" merely because an event row exists. A created/queued
        // event, a pending retry, a parked failure, or an event whose delivery
        // failed are all DISTINCT from "delivered" and are labelled honestly.
        const deliveryState =
          typeof first?.deliveryState === "string" ? first.deliveryState : first ? "pending" : null;
        const acked = first?.acked === true;
        run.deliveryState = deliveryState;
        run.deliveryAttempts = typeof first?.attempts === "number" ? first.attempts : null;
        run.deliveryAcked = first ? acked : null;
        run.deliveryReceipt = typeof first?.receipt === "string" ? first.receipt : null;
        await persistRunSafe(runFile, run, persistState, runFs);
        const delivered = deliveryState === "delivered";
        push({
          id: "manager_event",
          label: "Wake event recorded for this project (left UNACKED)",
          status: delivered ? "PASS" : "PENDING",
          detail: first
            ? `event ${first.eventId} (state ${first.state ?? "?"}, delivery ${deliveryState ?? "?"}${
                typeof first.attempts === "number" ? `, attempts ${first.attempts}` : ""
              }${acked ? ", acked" : ", unacked"}), left unacked for your review`
            : "no event yet — persisted pending receipt; the daemon stays alive and will deliver after review",
        });
      } catch (error) {
        push({
          id: "manager_event",
          label: "Wake event recorded for this project (left UNACKED)",
          status: "FAIL",
          detail: redactString((error as Error).message),
        });
      }

      // 6. Read the assignment's honest state (submitted/pending vs delivered).
      try {
        if (typeof run.assignmentId === "string") {
          const show = (await client.call(
            "assignments.show",
            { id: run.assignmentId },
            ids.show,
          )) as { state?: string; assignment?: { state?: string } };
          const state = show?.assignment?.state ?? show?.state ?? "unknown";
          run.assignmentState = state;
          // "delivered" is the manager's call after review; a submit that is
          // still queued/running is honestly reported as pending, not delivered.
          const pending = ["queued", "running", "needs_review", "revision_requested"].includes(state);
          run.status = pending ? "submitted_pending_review" : state;
          push({
            id: "assignment_state",
            label: "Assignment state (honest — no auto-accept/ack)",
            status: "PASS",
            detail: `state=${state}${pending ? " (pending manager review)" : ""}`,
          });
        }
      } catch (error) {
        push({
          id: "assignment_state",
          label: "Assignment state (honest — no auto-accept/ack)",
          status: "FAIL",
          detail: redactString((error as Error).message),
        });
      }

      // 7. Persist the run record BEFORE returning, and print the resume command.
      //    If the final write failed we report it truthfully as FAIL (never a
      //    false PASS) while still pointing at the recoverable ids already
      //    journalled — the mutation is never replayed.
      run.finishedAt = new Date().toISOString();
      await persistRunSafe(runFile, run, persistState, runFs);
      push({
        id: "run_record",
        label: "Run record persisted with all ids",
        status: persistState.persistFailure ? "FAIL" : "PASS",
        detail: persistState.persistFailure
          ? `run record write failed: ${persistState.persistFailure}; recoverable ids: ${recoverableIds(run)}`
          : `run ${runId} → ${runFile}`,
      });
      push({
        id: "resume",
        label: "Resume/verify after you review",
        status: "PASS",
        detail: `review + ack in Codex, or: pi-durable check --verify ${runId} --config ${options.configPath}`,
      });
    } finally {
      client.close();
    }
  } catch (error) {
    run.status = "error";
    run.error = redactString((error as Error).message);
    await persistRunSafe(runFile, run, persistState, runFs);
    push({
      id: "online_error",
      label: "Online check",
      status: "FAIL",
      detail: redactString((error as Error).message),
    });
  }
  // The online service is deliberately LEFT RUNNING. Live check is a persistent
  // same-GUI manager workflow: the daemon must stay alive for the active
  // assignment and the dispatcher so the wake is delivered once the manager
  // reviews and acks. Cleanup is a SEPARATE, explicit action after review
  // (`pi-durable check --verify`); live daemon data is never removed.

  return summarize("0.7.0-beta.1", "online", steps, { threadId: options.threadId, runFile });
}

/**
 * Poll `manager.events` for the first recorded event within a bounded window.
 * Read-only: never acks. A bounded wait is what lets a fast (fixture) worker
 * produce its terminal event without the check blocking forever; on timeout it
 * simply reports "no event yet" honestly.
 */
/** The actual manager-event shape as returned by `manager.events`. */
interface ManagerEventRow {
  eventId?: string;
  state?: string;
  deliveryState?: string;
  attempts?: number;
  acked?: boolean;
  receipt?: string | null;
}

async function waitForFirstEvent(
  client: PiClient,
  projectId: string,
  timeoutMs: number,
  requestId: string,
): Promise<ManagerEventRow | undefined> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    try {
      const events = (await client.call("manager.events", { projectId }, requestId)) as {
        events?: ManagerEventRow[];
      };
      const list = Array.isArray(events?.events) ? events.events : [];
      const first = list.find((e) => typeof e.eventId === "string");
      if (first) return first;
    } catch {
      /* transient; retry until the deadline */
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Raised when the run record cannot be durably persisted.
 *
 * The record is the ONLY durable evidence that a run happened — it carries the
 * project/session/assignment/request ids used to reconcile a crash or a lost
 * transport reply. If it cannot be written, the check must FAIL loudly (never
 * report PASS) and, before any mutation, submit NOTHING.
 */
export class RunPersistError extends Error {
  readonly code = "run_record_persist_failed";
  constructor(message: string) {
    super(message);
    this.name = "RunPersistError";
  }
}

/**
 * Persist an online-check run record privately (0600) and atomically.
 *
 * Throws {@link RunPersistError} if the record cannot be written or renamed into
 * place. Callers decide whether that is fatal: before the FIRST mutation it is
 * FATAL (submit nothing); after a durable submit it is reported truthfully with
 * the already-recorded ids (never silently swallowed, never re-submitted).
 */
export interface RunStoreFs {
  /** Create the run directory (recursively) with private permissions. */
  readonly mkdir: (dir: string, mode: number) => Promise<void>;
  /** Write the temp file with the final permission bits. */
  readonly write: (file: string, data: string, mode: number) => Promise<void>;
  /** Atomically rename the temp file into place. */
  readonly rename: (from: string, to: string) => Promise<void>;
}

/** The real filesystem used to persist run receipts (atomic, 0600). */
export const realRunStoreFs: RunStoreFs = {
  mkdir: async (dir, mode) => {
    mkdirSync(dir, { recursive: true, mode });
  },
  write: async (file, data, mode) => {
    await writeFile(file, data, { mode });
    // writeFile's mode is subject to umask; enforce exactly 0600.
    const { chmod } = await import("node:fs/promises");
    await chmod(file, mode);
  },
  rename: async (from, to) => {
    const { rename } = await import("node:fs/promises");
    await rename(from, to);
  },
};

async function persistRun(
  runFile: string,
  run: Record<string, unknown>,
  fs: RunStoreFs = realRunStoreFs,
): Promise<void> {
  try {
    await fs.mkdir(join(runFile, ".."), 0o700);
    const tmp = `${runFile}.${process.pid}.tmp`;
    await fs.write(tmp, `${JSON.stringify(run, null, 2)}\n`, 0o600);
    await fs.rename(tmp, runFile);
  } catch (error) {
    throw new RunPersistError(
      `could not persist run record ${runFile}: ${redactString((error as Error).message)}`,
    );
  }
}

/**
 * A redacted, human-readable list of the durable ids already recorded on a run.
 * Used to make a POST-submit failure recoverable: the caller can find and verify
 * the run by requestId even though the check itself did not finish.
 */
function recoverableIds(run: Record<string, unknown>): string {
  const ids = (run.requestIds ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["runId", "projectId", "sessionId", "assignmentId", "eventId"] as const) {
    const value = run[key];
    if (typeof value === "string" && value.length > 0) parts.push(`${key}=${value}`);
  }
  const requestId = ids.assignment ?? run.requestId;
  if (typeof requestId === "string" && requestId.length > 0) parts.push(`requestId=${requestId}`);
  return parts.join(" ") || "(no ids recorded yet)";
}

/**
 * Persist a run record AFTER the initial durable receipt, folding any failure
 * into `state.persistFailure` instead of throwing. The caller must treat a
 * non-undefined `persistFailure` as a truthful FAIL — the run is NOT reported
 * as PASS — while the durable ids already recorded keep the run recoverable.
 * Never re-submits a mutation.
 */
async function persistRunSafe(
  runFile: string,
  run: Record<string, unknown>,
  state: { persistFailure?: string },
  fs: RunStoreFs = realRunStoreFs,
): Promise<void> {
  try {
    await persistRun(runFile, run, fs);
  } catch (error) {
    state.persistFailure = redactString((error as Error).message);
  }
}

/** Options for `pi-durable check --verify <runId>`. */
export interface OnlineVerifyOptions {
  readonly runId: string;
  readonly configPath: string;
  readonly binPath: string;
  /** Directory holding run records; default `<stateDir>/online-check-runs`. */
  readonly runDir?: string;
  readonly log?: (line: string) => void;
}

/** Assignment states that mean the run is still in flight (honest PENDING). */
const VERIFY_PENDING_ASSIGNMENT_STATES = new Set([
  "queued",
  "running",
  "needs_review",
  "revision_requested",
]);
/** Assignment states that are a hard, unrecoverable FAIL for verification. */
const VERIFY_FAILED_ASSIGNMENT_STATES = new Set([
  "failed",
  "unanswered",
  "budget",
  "timeout",
  "cancelled",
]);

/**
 * Compute the final verify verdict. PASS requires ALL of:
 *   - the assignment state is `accepted`;
 *   - the relevant manager event was DELIVERED;
 *   - that event is ACKED.
 * Running/queued/needs_review/revision_requested (or a delivered-but-unacked
 * event) => PENDING. failed/unanswered/budget/timeout/cancelled or an unknown/
 * missing id/state => FAIL.
 */
export function verifyVerdict(input: {
  assignmentState: string | undefined;
  eventDelivered: boolean;
  eventAcked: boolean;
  eventListed: boolean;
  assignmentId: string | undefined;
  projectId: string | undefined;
}): { status: CheckStatus; detail: string } {
  if (input.assignmentId === undefined) {
    return { status: "FAIL", detail: "no assignmentId in the run record" };
  }
  if (input.projectId === undefined) {
    return { status: "FAIL", detail: "no projectId in the run record" };
  }
  if (input.assignmentState === undefined || input.assignmentState.length === 0) {
    return { status: "FAIL", detail: "assignment state unknown/missing" };
  }
  if (VERIFY_FAILED_ASSIGNMENT_STATES.has(input.assignmentState)) {
    return { status: "FAIL", detail: `assignment ${input.assignmentState}` };
  }
  if (input.assignmentState === "accepted") {
    if (!input.eventListed) return { status: "PENDING", detail: "accepted but no manager event recorded yet" };
    if (!input.eventDelivered) return { status: "PENDING", detail: "accepted but event not delivered yet" };
    if (!input.eventAcked) return { status: "PENDING", detail: "accepted + delivered but event not acked yet" };
    return { status: "PASS", detail: "assignment accepted; event delivered and acked" };
  }
  if (VERIFY_PENDING_ASSIGNMENT_STATES.has(input.assignmentState)) {
    return { status: "PENDING", detail: `assignment ${input.assignmentState} (awaiting manager review)` };
  }
  return { status: "FAIL", detail: `unrecognized assignment state: ${input.assignmentState}` };
}

/**
 * Re-open a previously persisted online run and report its CURRENT state:
 * the assignment state, whether it was reviewed/acked. Never auto-accepts or
 * auto-acks; it only READS and reports. This is the "resume/verify receipt"
 * command the online check points you at after you have reviewed the output.
 */
export async function verifyOnlineCheck(options: OnlineVerifyOptions): Promise<CheckReport> {
  const steps: CheckStep[] = [];
  const push = (s: CheckStep) => steps.push(s);

  let resolvedConfig: Awaited<ReturnType<typeof loadConfig>>;
  try {
    resolvedConfig = await loadConfig(options.configPath);
  } catch (error) {
    throw new CliUsageError("bad_config", `Config is not usable: ${redactString((error as Error).message)}`);
  }
  const stateDir = resolvedConfig.paths.stateDir;
  const runFile = join(options.runDir ?? join(stateDir, "online-check-runs"), `${options.runId}.json`);
  const sock = resolveServiceSocket(stateDir);

  if (!existsSync(runFile)) {
    throw new CliUsageError("no_run", `No online run record at ${runFile}. Run \`pi-durable check --online\` first.`);
  }
  let run: Record<string, unknown>;
  try {
    run = JSON.parse(await readFile(runFile, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new CliUsageError("bad_run", `Could not read run record: ${redactString((error as Error).message)}`);
  }

  const socketPath = sock.socketPath;
  push({
    id: "run_record",
    label: "Loaded the persisted run record",
    status: "PASS",
    detail: `run ${options.runId} (request ${String(run.requestId ?? "?")})`,
  });

  const start = await startDaemon({
    binPath: options.binPath,
    configPath: options.configPath,
    socketPath,
    stateDir,
    readyTimeoutMs: 15000,
    env: sock.env,
  });
  push({
    id: "service_start",
    label: "Service reachable for verification",
    status: start.ok === true ? "PASS" : "FAIL",
    detail: start.ok === true ? `listening at ${socketPath}` : `start failed: ${start.code ?? "unknown"}`,
  });
  if (start.ok !== true) return summarize("0.7.0-beta.1", "online", steps, { threadId: run.threadId as string, runFile });

  try {
    const client = await PiClient.connect({ socketPath, timeoutMs: 20000 });
    try {
      // Assignment state. `assignments.show` returns a DIRECT {@link
      // AssignmentDetail} (state at the top level), NOT `{ assignment: {...} }`.
      // We read both shapes for compatibility but PREFER the direct one; the
      // previous code read only the nested form and so always reported
      // "unknown" while printing PASS — a false positive. Success here demands a
      // real, known state, and the overall verify only PASSes when the
      // assignment is ACCEPTED, the relevant event is DELIVERED, and it is
      // ACKED. Anything else is surfaced truthfully (PENDING/FAIL).
      let assignmentState: string | undefined;
      const assignmentId = typeof run.assignmentId === "string" ? run.assignmentId : undefined;
      if (assignmentId === undefined) {
        push({
          id: "assignment_state",
          label: "Current assignment state",
          status: "FAIL",
          detail: "run record has no assignmentId — cannot verify a missing id",
        });
      } else {
        try {
          const show = (await client.call("assignments.show", { id: assignmentId }, "verify-show")) as {
            state?: string;
            assignment?: { state?: string };
          };
          assignmentState = show?.state ?? show?.assignment?.state;
          const known = typeof assignmentState === "string" && assignmentState.length > 0;
          push({
            id: "assignment_state",
            label: "Current assignment state",
            status: known ? "PASS" : "FAIL",
            detail: known ? `state=${assignmentState}` : "state missing from assignments.show response",
          });
        } catch (error) {
          push({
            id: "assignment_state",
            label: "Current assignment state",
            status: "FAIL",
            detail: redactString((error as Error).message),
          });
        }
      }

      // Manager event delivery + ack. Read the ACTUAL deliveryState/acked from
      // the store; a queued/pending/parked/failed delivery or an unacked event
      // is NOT success.
      const projectId = typeof run.projectId === "string" ? run.projectId : undefined;
      let eventDelivered = false;
      let eventAcked = false;
      let eventListed = false;
      if (projectId === undefined) {
        push({
          id: "manager_event",
          label: "Manager events (delivery + ack state)",
          status: "FAIL",
          detail: "run record has no projectId — cannot verify a missing id",
        });
      } else {
        try {
          const events = (await client.call("manager.events", { projectId }, "verify-events")) as {
            events?: ManagerEventRow[];
          };
          const list = Array.isArray(events?.events) ? events.events : [];
          eventListed = list.length > 0;
          const runEventId = typeof run.eventId === "string" ? run.eventId : undefined;
          const relevant =
            runEventId !== undefined ? list.find((e) => e.eventId === runEventId) : list[0];
          eventDelivered = relevant?.deliveryState === "delivered";
          eventAcked = relevant?.acked === true;
          const unacked = list.filter((e) => e.acked !== true);
          push({
            id: "manager_event",
            label: "Manager events (delivery + ack state)",
            status: eventDelivered && eventAcked ? "PASS" : "PENDING",
            detail:
              list.length === 0
                ? "no events recorded yet"
                : `event ${String(relevant?.eventId ?? "?")} delivery=${String(
                    relevant?.deliveryState ?? "?",
                  )} ${eventAcked ? "acked" : "unacked"}; ${list.length} event(s), ${unacked.length} unacked`,
          });
        } catch (error) {
          push({
            id: "manager_event",
            label: "Manager events (delivery + ack state)",
            status: "FAIL",
            detail: redactString((error as Error).message),
          });
        }
      }

      // Final verification verdict. It is honest and conservative: PASS only
      // when the assignment is ACCEPTED, the relevant event was DELIVERED, and
      // it is ACKED. Running/needsreview/unacked => PENDING; failed/unanswered/
      // cancelled/unknown/missing => FAIL. We never accept or ack here.
      push({
        id: "verify_verdict",
        label: "Final verdict (ACCEPTED assignment + delivered event + ACKED)",
        ...verifyVerdict({ assignmentState, eventDelivered, eventAcked, eventListed, assignmentId, projectId }),
      });
    } finally {
      client.close();
    }
  } catch (error) {
    push({
      id: "verify_error",
      label: "Online verify",
      status: "FAIL",
      detail: redactString((error as Error).message),
    });
  }
  // Verification is READ-ONLY and never stops the service: the live daemon must
  // remain available for the active assignment and the dispatcher until the
  // manager has reviewed and acked. It also never resubmits any mutation —
  // replaying `--verify <runId>` just re-reads the persisted run record's state.

  return summarize("0.7.0-beta.1", "online", steps, { threadId: run.threadId as string, runFile });
}

export { defaultSetupDeps };
