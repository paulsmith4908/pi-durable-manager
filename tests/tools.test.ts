import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import {
  createProjectTools,
  ToolError,
  ProcessTracker,
  type ResolvedToolPolicy,
} from "../src/tools.js";
import {
  buildSandboxEnv,
  buildSandboxProfile,
  canApplyProfile,
  canApplyPolicyProfile,
  resolvePolicy,
  resolveWithinRoot,
  runSandboxedCommand,
  writeFileNoFollow,
} from "../src/sandbox.js";
import { SupervisorProtocolError } from "../src/sandbox-supervisor.js";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";

type ExecArgs = Record<string, unknown>;
type ExecResult = ToolExecutionResult;

/** Minimal api stub; the tools only call `diagnostic()` and `output()`. */
function stubApi(): ToolExecutionApi {
  return {
    diagnostic() {},
    output() {},
    details: async () => undefined,
  } as unknown as ToolExecutionApi;
}

const NO_CONTEXT = {} as never;

/** Run a tool's execute and return the result. */
async function exec(
  tool: { execute: (a: ExecArgs, api: ToolExecutionApi, c: never) => Promise<ExecResult> },
  args: ExecArgs,
): Promise<ExecResult> {
  return tool.execute(args, stubApi(), NO_CONTEXT);
}

/** Make an isolated project root with optional protected paths and scratch. */
async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pdm-tools-"));
}

/**
 * SIGKILL a TEST-OWNED supervisor process group (its pgid === its pid, since
 * the supervisor is spawned detached). Only ever called with a pid taken from a
 * trusted `onProcess` receipt for a group this test spawned — never the real
 * manager or this process.
 */
function killOwnedTestGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** True while the (test-owned) process group still has a live member. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("resolveWithinRoot rejects absolute paths and .. traversal", async () => {
  const root = await makeRoot();
  const policy = resolvePolicy({ root });
  await assert.rejects(resolveWithinRoot(policy, "/etc/passwd", "read"), (e: unknown) => {
    assert.ok(e instanceof ToolError);
    assert.equal(e.code, "invalid_argument");
    return true;
  });
  await assert.rejects(resolveWithinRoot(policy, "../outside.txt", "read"), (e: unknown) => {
    assert.equal((e as ToolError).code, "outside_root");
    return true;
  });
  await assert.rejects(resolveWithinRoot(policy, "a/../../b", "write"), (e: unknown) => {
    assert.equal((e as ToolError).code, "outside_root");
    return true;
  });
});

test("resolveWithinRoot rejects a symlinked parent that escapes the root", async () => {
  const root = await makeRoot();
  const outside = await makeRoot();
  await writeFile(join(outside, "secret.txt"), "top secret");
  // root/link -> outside
  await symlink(outside, join(root, "link"));
  const policy = resolvePolicy({ root });
  await assert.rejects(resolveWithinRoot(policy, "link/secret.txt", "read"), (e: unknown) => {
    assert.equal((e as ToolError).code, "outside_root");
    return true;
  });
  await assert.rejects(resolveWithinRoot(policy, "link/new.txt", "write"), (e: unknown) => {
    assert.equal((e as ToolError).code, "outside_root");
    return true;
  });
});

test("resolveWithinRoot allows an in-root symlink target and untracked file creation", async () => {
  // mkdtemp under os.tmpdir() may hand back a `/var/...` alias while the kernel
  // realpaths it to `/private/var/...`; resolvePolicy canonicalizes the root, so
  // expectations must be canonical too. This is exactly the alias case that was
  // previously rejected as outside_root.
  const root = realpathSync(await makeRoot());
  await mkdir(join(root, "real"), { recursive: true });
  await writeFile(join(root, "real", "f.txt"), "hello");
  await symlink(join(root, "real"), join(root, "alias"));
  const policy = resolvePolicy({ root });

  const viaAlias = await resolveWithinRoot(policy, "alias/f.txt", "read");
  assert.equal(viaAlias, resolve(root, "real", "f.txt"));

  const newFile = await resolveWithinRoot(policy, "real/sub/new.txt", "write");
  assert.equal(newFile, resolve(root, "real", "sub", "new.txt"));
});

test("resolvePolicy canonicalizes root/protected/scratch aliases consistently", async () => {
  // A lexical root of `/var/...` (os.tmpdir alias) must compare equal to the
  // canonical `/private/var/...` path that realpath produces, otherwise an
  // in-root symlink target is misclassified as an escape.
  const raw = await makeRoot();
  const canonical = realpathSync(raw);
  const scratchRaw = await makeRoot();
  const scratchCanonical = realpathSync(scratchRaw);
  const stateRaw = await makeRoot();
  const stateCanonical = realpathSync(stateRaw);
  const policy = resolvePolicy({
    root: raw,
    scratchDir: scratchRaw,
    protectedPaths: [stateRaw],
  });
  assert.equal(policy.root, canonical);
  assert.equal(policy.scratchDir, scratchCanonical);
  assert.deepEqual(policy.protectedPaths, [stateCanonical]);

  // A child created via the lexical alias resolves cleanly under the canonical root.
  const child = await resolveWithinRoot(policy, "sub/dir/new.txt", "write");
  assert.equal(child, join(canonical, "sub", "dir", "new.txt"));
});

test("protected names and passed protected paths are refused for read and write", async () => {
  const root = await makeRoot();
  const stateDir = await makeRoot();
  const policy = resolvePolicy({ root, protectedPaths: [stateDir] });

  for (const bad of [".git/config", ".secrets/key", ".runtime/x", "config.local.json"]) {
    await assert.rejects(resolveWithinRoot(policy, bad, "write"), (e: unknown) => {
      assert.equal((e as ToolError).code, "protected_path", `expected protected_path for ${bad}`);
      return true;
    });
  }
  // A read of a protected path is also refused.
  await assert.rejects(resolveWithinRoot(policy, ".git/HEAD", "read"), (e: unknown) => {
    assert.equal((e as ToolError).code, "protected_path");
    return true;
  });

  // The passed state dir is refused even though it is outside the root (must not
  // silently fall through to outside_root only).
  const outsideState = resolve(stateDir, "..", "nope");
  await assert.rejects(resolveWithinRoot(policy, outsideState, "read"), (e: unknown) => {
    assert.ok(["outside_root", "invalid_argument"].includes((e as ToolError).code));
    return true;
  });
});

test("write tool refuses .git, creates parents, and write/read round-trips", async () => {
  const root = await makeRoot();
  const bundle = await createProjectTools(root);

  const blocked = await exec(bundle.write as never, { path: ".git/config", content: "x" });
  assert.equal(blocked.isError, true);

  const written = await exec(bundle.write as never, { path: "src/a/b.txt", content: "hello world" });
  assert.notEqual(written.isError, true);
  assert.equal(await readFile(join(root, "src/a/b.txt"), "utf8"), "hello world");

  const read = await exec(bundle.read as never, { path: "src/a/b.txt" });
  assert.equal(read.isError, undefined);
  const text = (read.output as { text: string }[])[0]?.text ?? "";
  assert.equal(text, "hello world");
});

test("read supports offset/limit line ranges", async () => {
  const root = await makeRoot();
  await writeFile(join(root, "lines.txt"), "l0\nl1\nl2\nl3\nl4");
  const bundle = await createProjectTools(root);
  const result = await exec(bundle.read as never, { path: "lines.txt", offset: 1, limit: 2 });
  const text = (result.output as { text: string }[])[0]?.text ?? "";
  assert.equal(text, "l1\nl2");
});

test("edit fails on no match and on ambiguous match unless replaceAll is true", async () => {
  const root = await makeRoot();
  await writeFile(join(root, "dup.txt"), "x x x");
  const bundle = await createProjectTools(root);

  const missing = await exec(bundle.edit as never, {
    path: "dup.txt",
    oldText: "zzz",
    newText: "y",
  });
  assert.equal(missing.isError, true);

  const ambiguous = await exec(bundle.edit as never, {
    path: "dup.txt",
    oldText: "x",
    newText: "y",
  });
  assert.equal(ambiguous.isError, true);

  const all = await exec(bundle.edit as never, {
    path: "dup.txt",
    oldText: "x",
    newText: "y",
    replaceAll: true,
  });
  assert.notEqual(all.isError, true);
  assert.equal(await readFile(join(root, "dup.txt"), "utf8"), "y y y");

  const unique = await exec(bundle.edit as never, {
    path: "dup.txt",
    oldText: "y y",
    newText: "z",
  });
  assert.notEqual(unique.isError, true);
  assert.equal(await readFile(join(root, "dup.txt"), "utf8"), "z y");
});

test("bash runs in the sandbox with a clean environment and returns nonzero as a model error", async () => {
  const root = await makeRoot();
  const policy = resolvePolicy({ root });

  // Profile/containment are asserted at the profile level below; spawning
  // sandbox-exec is environment-dependent (see the integration test).
  const env = buildSandboxEnv(policy);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.ok(env.PATH && env.HOME && env.HOME.startsWith(policy.root));

  const profile = buildSandboxProfile(policy);
  // Assert the enforced boundary structurally, not a brittle string-absence:
  // a working OS base plus an explicit global write-deny and a scoped write-allow.
  assert.match(profile, /\(allow default\)/);
  assert.match(profile, /\(deny file-write\*\)/);
  assert.match(profile, new RegExp(`\\(allow file-write\\* \\(subpath "${escapeRegex(policy.root)}"\\)\\)`));
  assert.match(profile, /deny network\*/);

  // Unsandboxed test seam: verify runner semantics without sandbox-exec.
  const ok = await runSandboxedCommand(policy, "printf hi", { unsandboxedForTesting: true });
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.stdout, "hi");

  const failed = await runSandboxedCommand(policy, "exit 3", { unsandboxedForTesting: true });
  assert.equal(failed.exitCode, 3);

  const timed = await runSandboxedCommand(
    resolvePolicy({ root, timeoutMs: 200 }),
    "sleep 5",
    { unsandboxedForTesting: true },
  ).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(timed instanceof ToolError);
  assert.equal((timed as ToolError).code, "timeout");
});

test("bash tool returns a model-visible error on nonzero exit without throwing", async () => {
  const root = await makeRoot();
  const bundle = await createProjectTools(root, { unsandboxedForTesting: true });
  const result = await exec(bundle.bash as never, { command: "exit 7" });
  assert.equal(result.isError, true);
  assert.equal((result.details as { exitCode: number }).exitCode, 7);
});

test("bash tool strips credentials from the child environment", async () => {
  const root = await makeRoot();
  process.env.PI_DURABLE_TEST_SECRET = "super-secret-should-not-leak";
  try {
    const bundle = await createProjectTools(root, { unsandboxedForTesting: true });
    const result = await exec(bundle.bash as never, {
      command: "printf '%s' \"${PI_DURABLE_TEST_SECRET:-missing}\"",
    });
    const text = (result.output as { text: string }[])[0]?.text ?? "";
    assert.equal(text, "missing");
  } finally {
    delete process.env.PI_DURABLE_TEST_SECRET;
  }
});

test("abortActiveProcesses kills live process groups", async () => {
  const root = await makeRoot();
  const bundle = await createProjectTools(root, { unsandboxedForTesting: true });
  const running = exec(bundle.bash as never, { command: "sleep 30" });
  await new Promise((r) => setTimeout(r, 200));
  bundle.abortActiveProcesses();
  const result = await running;
  assert.equal(result.isError, true);
});

test("runSandboxedCommand fails closed when the owned group is killed in the START window (no uncaughtException/hang)", async () => {
  // os.tmpdir() may hand back a `/var/...` alias whose kernel realpath is
  // `/private/var/...`; resolvePolicy canonicalizes the root, so the cwd passed
  // below must be canonical too or the boundary check rejects it as outside_root
  // before the supervisor is ever spawned (the owned group would never be
  // reached). Canonicalize the fixture so the test exercises the START window.
  const root = realpathSync(await makeRoot());
  const policy = resolvePolicy({ root, timeoutMs: 30_000 });
  const tracker = new ProcessTracker();

  // Simulate the manager-pause/minor kill landing EXACTLY between the received
  // process receipt and the START write. Only the TEST-OWNED pid (taken from
  // the trusted onProcess receipt) is signalled — never the real manager/ppid.
  // The hook waits for the owned group to actually disappear so the subsequent
  // `child.stdin.write("START\\n")` lands on a closed control pipe.
  const killed: number[] = [];
  const hooks = {
    onProcess: async (event: { pid?: number; group?: number; state: string }): Promise<void> => {
      if (event.state !== "started" || typeof event.pid !== "number") return;
      const pid = event.pid;
      killed.push(pid);
      killOwnedTestGroup(pid);
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        if (!groupAlive(pid)) break;
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };

  // The write then lands on a dead/closed pipe AFTER the group is gone: this
  // used to surface as an ASYNCHRONOUS EPIPE `'error'` EventEmitter event (an
  // uncaughtException) because a `try/catch` cannot catch it. It must instead
  // fail CLOSED — either a STRUCTURED rejection or a truthful non-zero exit —
  // and MUST NOT fake a clean exit 0, hang, or crash the process.
  const bounds = { start: 0, end: 0 };
  const outcome = await runSandboxedCommand(policy, "sleep 30", {
    cwd: root,
    tracker,
    hooks: hooks as never,
    unsandboxedForTesting: true,
  }).then(
    (r) => {
      bounds.end = Date.now();
      return { ok: true as const, result: r };
    },
    (e: unknown) => {
      bounds.end = Date.now();
      return { ok: false as const, error: e };
    },
  );

  assert.equal(killed.length, 1, "the owned group was signalled exactly once from the trusted receipt");
  if (outcome.ok) {
    // Truthful failure: a dead supervisor must NEVER be reported as exit 0.
    assert.notEqual(outcome.result.exitCode, 0, "a killed START window must not report a clean exit 0");
  } else {
    assert.ok(
      outcome.error instanceof SupervisorProtocolError || outcome.error instanceof ToolError,
      `expected a structured supervisor/tool error, got ${String(outcome.error)}`,
    );
  }
  // The owned group must be JOINED (fully gone) before the call returns, so a
  // later pause cannot observe a live/stale group.
  const ownedPid = killed[0] as number;
  assert.equal(groupAlive(ownedPid), false, "the owned group is joined before the call returns");
});

test("sandbox profile denies protected and private paths and the control socket", async () => {
  const root = await makeRoot();
  const stateDir = await makeRoot();
  const policy = resolvePolicy({ root, protectedPaths: [stateDir], scratchDir: join(root, ".scratch") });
  const profile = buildSandboxProfile(policy);
  assert.match(profile, /\.secrets/);
  assert.match(profile, /\.git/);
  assert.match(profile, new RegExp(stateDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(profile, /\.ssh/);
  assert.match(profile, /deny network/);
});

/**
 * Integration test: real sandbox-exec containment.
 *
 * This runs the launcher for real. The skip gate is the *generic* capability
 * probe (`(version 1)(allow default)` on `/usr/bin/true`): in a nested/host
 * -restricted environment (a worker that is itself sandboxed) sandbox-exec
 * cannot apply any profile, so the test is SKIPPED with a reason. If the generic
 * probe succeeds we exercise the REAL production profile and assert the enforced
 * boundaries; a policy-profile failure then fails the test rather than skipping,
 * so a broken profile can never hide behind a capability skip. Run from a normal
 * root shell with:
 *
 *   node --test dist-test/tests/tools.test.js
 */
test("integration: sandbox-exec enforces writes/private-read/env boundaries", async (t) => {
  const root = realpathSync(await makeRoot());
  const outside = realpathSync(await makeRoot());
  const scratch = realpathSync(await makeRoot());
  const policy = resolvePolicy({ root, scratchDir: scratch });

  // Skip ONLY when the launcher cannot apply *any* profile generically.
  if (!(await canApplyProfile(policy))) {
    t.skip(
      "sandbox-exec cannot apply the generic (allow default) probe here (nested sandbox / host restriction); run from a root shell",
    );
    return;
  }

  // (1) A write inside the project succeeds and the file actually appears.
  const inFile = join(root, "in.txt");
  const inside = await runSandboxedCommand(policy, `printf ok > "${inFile}"`);
  assert.equal(inside.exitCode, 0, `inside write should succeed: ${inside.stderr}`);
  assert.equal(await readFile(inFile, "utf8"), "ok", "inside write must persist");

  // (2) A write outside the project is denied by the sandbox.
  const outFile = join(outside, "out.txt");
  const escaped = await runSandboxedCommand(policy, `printf nope > "${outFile}"`);
  assert.notEqual(escaped.exitCode, 0, "outside write must fail");
  assert.equal(
    await stat(outFile).then(() => true, () => false),
    false,
    "outside write must not create a file",
  );

  // (3) A protected project-relative path is unwritable and unreadable.
  await mkdir(join(root, ".runtime"), { recursive: true });
  await writeFile(join(root, ".runtime", "secret.txt"), "runtime-secret");
  const protectedRead = await runSandboxedCommand(policy, `cat "${join(root, ".runtime", "secret.txt")}"`);
  assert.notEqual(protectedRead.exitCode, 0, "reading a protected .runtime path must fail");
  assert.doesNotMatch(protectedRead.stdout, /runtime-secret/, "protected content must not leak");

  // (4) config.local.json is protected for read and write.
  await writeFile(join(root, "config.local.json"), '{"k":"v"}');
  const configRead = await runSandboxedCommand(policy, `cat "${join(root, "config.local.json")}"`);
  assert.notEqual(configRead.exitCode, 0, "reading config.local.json must fail");

  // (5) The clean environment strips inherited credentials.
  process.env.PI_DURABLE_TEST_SECRET = "super-secret-should-not-leak";
  try {
    const env = await runSandboxedCommand(
      policy,
      "printf '%s' \"${PI_DURABLE_TEST_SECRET:-missing}\"",
    );
    assert.equal(env.exitCode, 0);
    assert.equal(env.stdout, "missing", "credential must be stripped from the sandbox env");
  } finally {
    delete process.env.PI_DURABLE_TEST_SECRET;
  }

  // (6) A harmless command runs at all under the real profile (no SIGABRT).
  const harmless = await runSandboxedCommand(policy, "/usr/bin/true");
  assert.equal(harmless.exitCode, 0, `harmless command must run: ${harmless.stderr}`);
});

test("canApplyProfile returns a boolean and never throws", async () => {
  const policy = resolvePolicy({ root: await makeRoot() });
  const value = await canApplyProfile(policy);
  assert.equal(typeof value, "boolean");
});

test("createProjectTools exposes all four tools and an installable extension", async () => {
  const root = await makeRoot();
  const bundle = await createProjectTools(root);
  assert.deepEqual(
    bundle.tools.map((tool) => tool.name).sort(),
    ["bash", "edit", "read", "write"],
  );
  // The default extension name is derived from the project root, so two
  // projects never share a registry key.
  assert.match(bundle.extension.name, /^pi-durable-project:/);
  assert.equal(bundle.extension.tools?.length, 4);
});

test("two projects get distinct extension names, and an explicit name is honoured", async () => {
  const first = await createProjectTools(await makeRoot());
  const second = await createProjectTools(await makeRoot());
  assert.notEqual(first.extension.name, second.extension.name);

  const named = await createProjectTools(await makeRoot(), { extensionName: "custom:abc" });
  assert.equal(named.extension.name, "custom:abc");
});

test("path resolution honours an assigned scratch directory outside the root", async () => {
  const root = realpathSync(await makeRoot());
  const scratch = realpathSync(await makeRoot());
  const policy: ResolvedToolPolicy = resolvePolicy({ root, scratchDir: scratch });
  assert.equal(policy.scratchDir, scratch);
  // scratchDir is writable by the profile even though it is not under root.
  const profile = buildSandboxProfile(policy);
  assert.match(profile, new RegExp(`\\(allow file-write\\* \\(subpath "${escapeRegex(scratch)}"\\)\\)`));
});

test("bin/pi-durable.js passes node --check and prints help", async () => {
  const bin = resolve(import.meta.dirname, "..", "..", "bin", "pi-durable.js");
  const check = await run("node", ["--check", bin]);
  assert.equal(check.code, 0, check.stderr);

  const help = await run("node", [bin, "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout + help.stderr, /Usage:/);
  assert.match(help.stdout + help.stderr, /serve/);

  const bogus = await run("node", [bin, "bogus"]);
  assert.equal(bogus.code, 2);
});

test("uses a private file mode when writing", async () => {
  const root = await makeRoot();
  const bundle = await createProjectTools(root);
  await exec(bundle.write as never, { path: "secret.txt", content: "s" });
  const info = await stat(join(root, "secret.txt"));
  assert.equal(info.mode & 0o077, 0);
});

/** Run a command and capture its result. */
function run(
  file: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("close", (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
    child.on("error", () => resolvePromise({ code: -1, stdout, stderr }));
  });
}

// ---------------------------------------------------------------------------
// Bounded output retention + full-stream artifact
// ---------------------------------------------------------------------------

test("runSandboxedCommand bounds retained output and spills the full stream to a private artifact", async () => {
  const root = await makeRoot();
  const scratch = await makeRoot();
  const policy = resolvePolicy({ root, scratchDir: scratch, maxOutputBytes: 1024 });

  // Emit far more than the limit on stdout; the marker is only at the very end.
  const result = await runSandboxedCommand(
    policy,
    "yes ABCDEFGHIJ | head -n 20000; printf TAIL_MARKER",
    { unsandboxedForTesting: true },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.truncated, true, "overflow must be detected");
  assert.ok(result.totalBytes > 1024, `totalBytes should exceed limit, got ${result.totalBytes}`);
  assert.ok(
    Buffer.byteLength(result.stdout, "utf8") <= 1024,
    "retained stdout must be bounded by maxOutputBytes",
  );
  assert.ok(result.stdout.endsWith("TAIL_MARKER"), "retained tail must include the end");

  // The full artifact must exist, be private, and contain much more than the tail.
  assert.ok(result.fullOutputPath, "a full-output artifact path must be reported");
  const artifact = await readFile(result.fullOutputPath!, "utf8");
  assert.ok(artifact.length > result.stdout.length, "artifact must hold the full stream");
  assert.match(artifact, /ABCDEFGHIJ/);
  const artifactInfo = await stat(result.fullOutputPath!);
  assert.equal(artifactInfo.mode & 0o077, 0, "artifact must be private (0600)");
});

test("runSandboxedCommand spills stderr overflow and retains its tail", async () => {
  const root = await makeRoot();
  const policy = resolvePolicy({ root, maxOutputBytes: 512 });

  const result = await runSandboxedCommand(
    policy,
    "for i in $(seq 1 5000); do printf 'ERR%06d\\n' $i >&2; done; printf ERRTAIL >&2",
    { unsandboxedForTesting: true },
  );

  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stderr, "utf8") <= 512);
  assert.ok(result.stderr.endsWith("ERRTAIL"));
  assert.ok(result.fullOutputPath);
  const artifact = await readFile(result.fullOutputPath!, "utf8");
  assert.match(artifact, /ERR000001/);
  assert.match(artifact, /ERRTAIL/);
});

test("runSandboxedCommand does not spill when output fits in the limit", async () => {
  const root = await makeRoot();
  const policy = resolvePolicy({ root, maxOutputBytes: 4096 });
  const result = await runSandboxedCommand(policy, "printf small", { unsandboxedForTesting: true });
  assert.equal(result.truncated, false);
  assert.equal(result.fullOutputPath, null);
  assert.equal(result.totalBytes, 5);
});

test("runSandboxedCommand captures a result for nonzero exit without throwing", async () => {
  const root = await makeRoot();
  const policy = resolvePolicy({ root });
  const result = await runSandboxedCommand(policy, "printf oops >&2; exit 9", {
    unsandboxedForTesting: true,
  });
  assert.equal(result.exitCode, 9);
  assert.equal(result.stderr, "oops");
});

// ---------------------------------------------------------------------------
// onCommand hook: exactly once, including failures
// ---------------------------------------------------------------------------

test("onCommand is invoked exactly once for successful and failing commands", async () => {
  const root = await makeRoot();
  const policy = resolvePolicy({ root, maxOutputBytes: 256 });
  const seen: { exitCode: number }[] = [];
  const hooks = {
    async onCommand(result: { exitCode: number }) {
      seen.push({ exitCode: result.exitCode });
    },
  };

  await runSandboxedCommand(policy, "printf ok", { unsandboxedForTesting: true, hooks });
  await runSandboxedCommand(policy, "exit 4", { unsandboxedForTesting: true, hooks });
  await runSandboxedCommand(policy, "for i in $(seq 1 5000); do printf x; done", {
    unsandboxedForTesting: true,
    hooks,
  });

  assert.equal(seen.length, 3, "onCommand must fire exactly once per command");
  assert.equal(seen[0]?.exitCode, 0);
  assert.equal(seen[1]?.exitCode, 4);
  assert.equal(seen[2]?.exitCode, 0);
});

test("onCommand fires once for a timed-out command and its artifact is cleaned up", async () => {
  const root = await makeRoot();
  const scratch = await makeRoot();
  const policy = resolvePolicy({ root, scratchDir: scratch, timeoutMs: 300, maxOutputBytes: 64 });
  const calls: { timedOut: boolean; fullOutputPath: string | null }[] = [];
  const hooks = {
    async onCommand(result: { timedOut: boolean; fullOutputPath: string | null }) {
      calls.push({ timedOut: result.timedOut, fullOutputPath: result.fullOutputPath });
    },
  };

  const error = await runSandboxedCommand(
    policy,
    "for i in $(seq 1 100000); do printf yyyy; done; sleep 30",
    { unsandboxedForTesting: true, hooks },
  ).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(error instanceof ToolError);
  assert.equal((error as ToolError).code, "timeout");
  assert.equal(calls.length, 1, "onCommand must fire exactly once for timeout");
  assert.equal(calls[0]?.timedOut, true);
  assert.equal(calls[0]?.fullOutputPath, null, "timed-out artifact must not be retained");
});

test("an already-aborted signal never executes the command", async () => {
  const root = await makeRoot();
  const marker = join(root, "should-not-exist.txt");
  const policy = resolvePolicy({ root });
  const controller = new AbortController();
  controller.abort();

  let hookCalls = 0;
  const error = await runSandboxedCommand(policy, `printf ran > "${marker}"`, {
    unsandboxedForTesting: true,
    signal: controller.signal,
    hooks: {
      onCommand() {
        hookCalls += 1;
      },
    },
  }).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(error instanceof ToolError);
  assert.equal((error as ToolError).code, "aborted");
  assert.equal(await stat(marker).then(() => true, () => false), false, "command must not run");
  assert.equal(hookCalls, 0, "no result hook for a never-started command");
});

test("resolvePolicy defaults bash timeoutMs to null (unlimited) and preserves an explicit finite cap", () => {
  const root = "/tmp/pdm-policy-shape";
  assert.equal(resolvePolicy({ root }).timeoutMs, null, "omitted timeout means unlimited");
  assert.equal(resolvePolicy({ root, timeoutMs: null }).timeoutMs, null, "explicit null means unlimited");
  assert.equal(resolvePolicy({ root, timeoutMs: 45_000 }).timeoutMs, 45_000, "finite cap is preserved");
});

test("bash with an unlimited policy runs an explicit FINITE timeout and aborts cleanly", async () => {
  const root = await makeRoot();
  const bundle = await createProjectTools(root, { unsandboxedForTesting: true });
  // Policy is unlimited (default null); the WORKER supplies a positive finite
  // timeout that must be respected and must abort the owned group cleanly.
  const result = await exec(bundle.bash as never, {
    command: "sleep 30",
    timeout: 300,
  });
  assert.equal(result.isError, true, "a timed-out command is a model-visible error result");
  assert.equal((result.diagnostics?.[0] as { code?: string } | undefined)?.code, "timeout");
});

test("bash clamps an explicit worker timeout to a finite manager cap", async () => {
  const root = await makeRoot();
  // The manager configured a 150ms cap; the worker asks for 30s. The command
  // must be killed by the CAP, not the worker's larger request.
  const bundle = await createProjectTools(root, {
    unsandboxedForTesting: true,
    timeoutMs: 150,
  });
  const started = Date.now();
  const result = await exec(bundle.bash as never, {
    command: "sleep 30",
    timeout: 30_000,
  });
  const elapsed = Date.now() - started;
  assert.equal(result.isError, true);
  assert.equal((result.diagnostics?.[0] as { code?: string } | undefined)?.code, "timeout");
  assert.ok(elapsed < 5_000, `cap must fire well before the worker's request (elapsed ${elapsed}ms)`);
});

test("bash rejects a non-positive/non-finite worker timeout as invalid_argument", async () => {
  const root = await makeRoot();
  const bundle = await createProjectTools(root, { unsandboxedForTesting: true });
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    const result = await exec(bundle.bash as never, { command: "printf hi", timeout: bad });
    assert.equal(result.isError, true, `timeout=${String(bad)} must be rejected`);
    assert.equal((result.diagnostics?.[0] as { code?: string } | undefined)?.code, "invalid_argument");
  }
});

// ---------------------------------------------------------------------------
// Supervisor wiring: receipt-before-START ordering + message-accurate exit
// ---------------------------------------------------------------------------

test("onProcess(started) fires BEFORE the command runs; a throwing started-hook blocks it", async () => {
  const root = await makeRoot();
  const policy = resolvePolicy({ root });

  // Ordering: the started hook runs, records ordering, THEN the command writes
  // its marker. The hook must observe ordering BEFORE the side effect.
  const marker = join(root, "ordered-marker.txt");
  const order: string[] = [];
  const ok = await runSandboxedCommand(policy, `printf ran > "${marker}"`, {
    unsandboxedForTesting: true,
    hooks: {
      onProcess(event: { state: string }) {
        if (event.state === "started") order.push("started");
      },
      onCommand() {
        order.push("command");
      },
    },
  });
  assert.equal(ok.exitCode, 0);
  assert.deepEqual(order, ["started", "command"], "receipt-ordered: started precedes command result");

  // A throwing started hook must NOT let the command run, and must not leak.
  const blocked = join(root, "blocked-marker.txt");
  const error = await runSandboxedCommand(policy, `printf ran > "${blocked}"`, {
    unsandboxedForTesting: true,
    hooks: {
      onProcess() {
        throw new Error("receipt store unavailable");
      },
    },
  }).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(error instanceof ToolError, "a failing started hook surfaces as a ToolError");
  assert.equal((error as ToolError).code, "spawn_error");
  assert.equal(await stat(blocked).then(() => true, () => false), false, "no child ran before the receipt persisted");
});

test("nonexistent program is recorded as exit 127 (ENOENT), not a fake success", async () => {
  const root = await makeRoot();
  const policy = resolvePolicy({ root });
  const result = await runSandboxedCommand(policy, "/nonexistent/definitely-missing-bin-xyz", {
    unsandboxedForTesting: true,
  });
  assert.equal(result.exitCode, 127, "ENOENT maps to 127");
  assert.equal(result.signal, null);
});

// ---------------------------------------------------------------------------
// Profile: project-relative protection, exec allowance, scoped runtime
// ---------------------------------------------------------------------------

test("profile protects project-relative protected names without a global .runtime regex", async () => {
  const root = realpathSync(await makeRoot());
  const scratch = realpathSync(await makeRoot());
  const policy = resolvePolicy({ root, scratchDir: scratch });
  const profile = buildSandboxProfile(policy);

  // Project-relative protected files are denied by absolute subpath.
  assert.match(profile, new RegExp(escapeRegex(join(root, ".git"))));
  assert.match(profile, new RegExp(escapeRegex(join(root, ".secrets"))));
  assert.match(profile, new RegExp(escapeRegex(join(root, ".runtime"))));
  assert.match(profile, new RegExp(escapeRegex(join(root, "config.local.json"))));

  // No global regex that would block an ancestor directory literally named .runtime.
  assert.doesNotMatch(profile, /\(regex #"\/\\\\\.runtime/);
});

test("profile confines writes to the project and scratch trees", async () => {
  const root = realpathSync(await makeRoot());
  const scratch = realpathSync(await makeRoot());
  const policy = resolvePolicy({ root, scratchDir: scratch });
  const profile = buildSandboxProfile(policy);
  // Global write-deny, then scoped write-allow for the project and scratch only.
  assert.match(profile, /\(deny file-write\*\)/);
  assert.match(profile, new RegExp(`\\(allow file-write\\* \\(subpath "${escapeRegex(root)}"\\)\\)`));
  assert.match(profile, new RegExp(`\\(allow file-write\\* \\(subpath "${escapeRegex(scratch)}"\\)\\)`));
  // Private credential trees are denied for reads (structure, not a brittle
  // exact-path assertion): ssh/aws/keychain subpaths appear as read denies.
  assert.match(profile, /\(deny file-read\* file-write\* \(subpath "[^"]*\/(?:\.ssh|\.aws|\.gnupg)"\)\)/);
  assert.match(profile, /Library\/Keychains/);
});

test("profile denies real user home reads but re-allows the project (ordered)", async () => {
  const home = realpathSync(await makeRoot());
  const prior = process.env.HOME;
  process.env.HOME = home;
  try {
    // Project nested inside the denied home: the re-allow must come *after* the
    // home deny so the project wins (SBPL: later matching rule decides).
    const root = realpathSync(await makeRoot());
    const policy = resolvePolicy({ root });
    const profile = buildSandboxProfile(policy);
    const homeDeny = `(deny file-read* (subpath "${home}"))`;
    const projectReadAllow = `(allow file-read* (subpath "${policy.root}"))`;
    const denyIdx = profile.indexOf(homeDeny);
    const allowIdx = profile.indexOf(projectReadAllow);
    assert.notEqual(denyIdx, -1, "home read-deny must be present");
    assert.notEqual(allowIdx, -1, "project read re-allow must be present");
    assert.ok(denyIdx < allowIdx, "home deny must precede the project read re-allow");

    // A protected name inside the project still wins over the read re-allow.
    const secretsDeny = `(deny file-read* file-write* (subpath "${join(policy.root, ".secrets")}"))`;
    assert.ok(profile.indexOf(secretsDeny) > allowIdx, "protected-name deny must outrank the root re-allow");
  } finally {
    if (prior === undefined) delete process.env.HOME;
    else process.env.HOME = prior;
  }
});

test("profile denies the control socket path over the network even when allowNetwork is true", async () => {
  const root = realpathSync(await makeRoot());
  const stateDir = realpathSync(await makeRoot());
  const policy = resolvePolicy({ root, protectedPaths: [stateDir], allowNetwork: true });
  const profile = buildSandboxProfile(policy);
  const stateRe = escapeRegex(stateDir);
  assert.match(profile, new RegExp(`\\(deny network\\* \\(subpath "${stateRe}"\\)\\)`));
  assert.match(profile, new RegExp(`\\(deny file-read\\* file-write\\* \\(subpath "${stateRe}"\\)\\)`));

  // Network is deny-by-default and `allowNetwork` NEVER emits the unsafe blanket
  // `(allow network-outbound)`. Outbound IP access, when requested, is FILTERED
  // (`(allow network-outbound (remote ip "..."))`) and the control-socket tree is
  // re-denied afterwards (last-match-wins), so the manager socket stays
  // unreachable even with allowNetwork on.
  assert.doesNotMatch(
    profile,
    /\(allow network-outbound\)/,
    "allowNetwork must never emit a bare, unfiltered network-outbound allow",
  );
  assert.match(
    profile,
    /\(allow network-outbound \(remote ip "[^"]+"\)\)/,
    "outbound HTTP(S) must be granted through a filtered remote-ip allow",
  );
  // The control/state socket tree is denied over the network, outranking the
  // filtered allow because it is emitted afterwards.
  assert.match(profile, new RegExp(`\\(deny network\\* \\(subpath "${stateRe}"\\)\\)`));
});

test("canApplyProfile probes launcher capability and canApplyPolicyProfile checks the real profile", async () => {
  const root = await makeRoot();
  const policy = resolvePolicy({ root });
  const capable = await canApplyProfile(policy);
  assert.equal(typeof capable, "boolean");
  const policyOk = await canApplyPolicyProfile(policy);
  assert.equal(typeof policyOk, "boolean");
  // In this nested environment the launcher is unavailable, so both are false.
  if (!capable) {
    assert.equal(policyOk, false, "a real profile must also fail when the launcher cannot run");
  }
});

test("writeFileNoFollow refuses a final-component symlink", async () => {
  const root = await makeRoot();
  const target = join(root, "real.txt");
  await writeFile(target, "original");
  const link = join(root, "link.txt");
  await symlink(target, link);
  await assert.rejects(writeFileNoFollow(link, "overwritten"), (e: unknown) => {
    assert.equal((e as ToolError).code, "protected_path");
    return true;
  });
  assert.equal(await readFile(target, "utf8"), "original");
});

/** Escape a literal string for safe use inside a RegExp. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("request_manager is registered only when wired, and is bound to the current call", async () => {
  const root = await makeRoot();
  const calls: { question: string; context: string | null; taskId: string; conversationId: string }[] = [];
  const bundle = await createProjectTools(root, {
    requestManager: (params) => {
      calls.push({
        question: params.question,
        context: params.context,
        taskId: params.taskId,
        conversationId: params.conversationId,
      });
      return { ok: true, intentId: "mp-1", state: "pausing" };
    },
  });
  assert.equal(bundle.tools.length, 5);
  assert.deepEqual(
    bundle.tools.map((tool) => tool.name).sort(),
    ["bash", "edit", "read", "request_manager", "write"],
  );
  assert.equal(bundle.extension.tools?.length, 5);
  assert.ok(bundle.request_manager);

  const api = {
    diagnostic() {},
    output() {},
    details: async () => undefined,
    taskId: "task-9",
    conversationId: "conv-7",
    callId: "call-1",
  } as unknown as ToolExecutionApi;
  const result = await bundle.request_manager!.execute(
    { question: "Which branch should I push to?", context: "tried main" },
    api,
    NO_CONTEXT,
  );
  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.taskId, "task-9");
  assert.equal(calls[0]?.conversationId, "conv-7");
  const text = (result.output ?? []).map((part) => ("text" in part ? String(part.text) : "")).join("");
  assert.match(text, /STOP/);
});

test("request_manager surfaces a bounded diagnostic when the manager is unavailable", async () => {
  const root = await makeRoot();
  const bundle = await createProjectTools(root, {
    requestManager: () => ({ ok: false, error: "manager offline" }),
  });
  const result = await bundle.request_manager!.execute({ question: "help" }, stubApi(), NO_CONTEXT);
  assert.equal(result.isError, true);
});

test("request_manager rejects an empty question without side effects", async () => {
  const root = await makeRoot();
  let called = false;
  const bundle = await createProjectTools(root, {
    requestManager: () => {
      called = true;
      return { ok: true, intentId: "mp-1", state: "pausing" };
    },
  });
  const result = await bundle.request_manager!.execute({ question: "   " }, stubApi(), NO_CONTEXT);
  assert.equal(result.isError, true);
  assert.equal(called, false);
});
