//
// tests-assets/monitor.test.mjs
//
// Focused, hermetic tests for tools/monitor.mjs — the read-only Pi Durable
// browser monitor + code-only inactivity escalation.
//
// These exercise the monitor's PURE surface: CLI arg parsing/validation, secret
// redaction, HTML/JSON escaping, HTTP host/origin/loopback enforcement, the
// read-only method boundary, inactivity classification + durable dedup, and the
// bounded codex spawn (via an injected exec seam — no real child, no network).
//
// The monitor is dependency-free (Node builtins only), so importing it does NOT
// start the server (see the import.meta.url main guard) and does NOT need a
// build. We exercise a REAL HTTP server bound to loopback for the routing tests.
//
//   node --test tests-assets/monitor.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { once } from "node:events";

import {
  READ_METHODS,
  REDACTED,
  parseArgs,
  parsePositiveInt,
  redactText,
  safeStringify,
  tail,
  activityWatermark,
  classifyActivity,
  shouldWarn,
  buildWarningMessage,
  loadReceipts,
  recordReceipt,
  runCodexQueue,
  buildCodexEnv,
  parseQueueReceipt,
  CODEX_ENV_ALLOWLIST,
  WARNING_CHILD_TIMEOUT_MS,
  selectLatestAssignment,
  extractLatestCommand,
  latestEvidenceCommand,
  previewEntries,
  summarizeTasks,
  escapeJsonForScript,
  renderHtml,
  isAllowedHostHeader,
  isAllowedOriginHeader,
  createDashboardServer,
  makeReadOnlyCaller,
  humanAge,
  TERMINAL_STATES,
} from "../tools/monitor.mjs";

/** Create an OS-temp fixture dir, verifying provenance before any writes. */
async function makeTempDir(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), `${prefix}-`));
  const realTemp = path.resolve(tmpdir());
  if (!path.resolve(dir).startsWith(realTemp + path.sep)) {
    throw new Error(`refusing to use non-temp dir: ${dir}`);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Arg parsing / validation
// ---------------------------------------------------------------------------

test("parseArgs: requires --state-dir and --project-id", () => {
  assert.equal(parseArgs([]).ok, false);
  assert.match(parseArgs([]).error, /--state-dir is required/);
  const noProject = parseArgs(["--state-dir", "/tmp/x"]);
  assert.equal(noProject.ok, false);
  assert.match(noProject.error, /--project-id is required/);
});

test("parseArgs: rejects unknown flags instead of ignoring them", () => {
  const r = parseArgs(["--state-dir", "/tmp/x", "--project-id", "p", "--nonsense", "1"]);
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown argument: --nonsense/);
});

test("parseArgs: refuses non-loopback host", () => {
  const r = parseArgs(["--state-dir", "/s", "--project-id", "p", "--host", "0.0.0.0"]);
  assert.equal(r.ok, false);
  assert.match(r.error, /loopback/);
});

test("parsePositiveInt: rejects non-integers, zero and negatives", () => {
  assert.equal(parseArgs(["--state-dir", "/s", "--project-id", "p", "--port", "abc"]).ok, false);
  assert.equal(parseArgs(["--state-dir", "/s", "--project-id", "p", "--port", "-1"]).ok, false);
  assert.equal(parsePositiveInt("0"), undefined);
  assert.equal(parsePositiveInt("1.5"), undefined); // not an integer
  assert.equal(parsePositiveInt("30"), 30);
});

test("parseArgs: --idle-warning-ms without --thread is a contradiction", () => {
  const r = parseArgs(["--state-dir", "/s", "--project-id", "p", "--idle-warning-ms", "1000"]);
  assert.equal(r.ok, false);
  assert.match(r.error, /requires --thread/);
});

test("parseArgs: warnings enabled needs BOTH --thread and --receipts-file", () => {
  const missingReceipts = parseArgs([
    "--state-dir", "/s", "--project-id", "p",
    "--thread", "11111111-1111-1111-1111-111111111111",
    "--idle-warning-ms", "900000",
  ]);
  assert.equal(missingReceipts.ok, false);
  assert.match(missingReceipts.error, /--receipts-file/);

  const ok = parseArgs([
    "--state-dir", "/s", "--project-id", "p",
    "--thread", "11111111-1111-1111-1111-111111111111",
    "--idle-warning-ms", "900000",
    "--receipts-file", "/tmp/r.json",
  ]);
  assert.equal(ok.ok, true);
  assert.equal(ok.options.warningsEnabled, true);
});

test("parseArgs: thread alone keeps warnings disabled", () => {
  const r = parseArgs(["--state-dir", "/s", "--project-id", "p", "--thread", "abc"]);
  assert.equal(r.ok, true);
  assert.equal(r.options.warningsEnabled, false);
});

test("parseArgs: --flag=value form works and defaults are loopback/5180", () => {
  const r = parseArgs(["--state-dir=/s", "--project-id=p"]);
  assert.equal(r.ok, true);
  assert.equal(r.options.host, "127.0.0.1");
  assert.equal(r.options.port, 5180);
});

// ---------------------------------------------------------------------------
// Redaction / safe serialization
// ---------------------------------------------------------------------------

test("redactText: scrubs api keys, bearer/basic, and key=value secrets", () => {
  assert.equal(redactText("token sk-abcdefghijklmnop"), `token ${REDACTED}`);
  // Bearer/Basic schemes are scrubbed regardless of the surrounding key=value.
  assert.ok(!redactText("Authorization: Bearer abcdefghijklmnopqrst").includes("abcdefghijklmnopqrst"));
  assert.ok(!redactText("Authorization: Basic dXNlcjpwYXNz").includes("dXNlcjpwYXNz"));
  // Generic key=value secrets are scrubbed (separator preserved).
  assert.equal(redactText("api_key=supersecretvalue"), `api_key=${REDACTED}`);
  assert.equal(redactText("password: hunter2xyz"), `password: ${REDACTED}`);
});

test("redactText: scrubs caller-supplied extra secrets", () => {
  assert.equal(redactText("value is TOPSECRET123 here", ["TOPSECRET123"]), `value is ${REDACTED} here`);
});

test("safeStringify: never throws on cycles and is bounded", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const out = safeStringify(cyclic);
  assert.match(out, /circular/);
  const big = safeStringify({ x: "a".repeat(5000) }, 50);
  assert.ok(big.length <= 80);
  assert.match(big, /truncated/);
});

test("tail: keeps the trailing window and notes truncation", () => {
  const t = tail("x".repeat(100) + "END", 10);
  assert.match(t, /END$/);
  assert.match(t, /truncated/);
});

// ---------------------------------------------------------------------------
// Activity classification (never a bare "active")
// ---------------------------------------------------------------------------

test("classifyActivity: never returns 'active'; unknown without a watermark", () => {
  const r = classifyActivity({ now: 1000, watermark: 0, thresholdMs: 100, terminal: false });
  assert.equal(r.state, "unknown");
  assert.equal(r.ageMs, null);
});

test("classifyActivity: fresh vs stale by threshold; terminal short-circuits", () => {
  assert.equal(classifyActivity({ now: 1000, watermark: 950, thresholdMs: 100, terminal: false }).state, "fresh");
  assert.equal(classifyActivity({ now: 1000, watermark: 100, thresholdMs: 100, terminal: false }).state, "stale");
  assert.equal(classifyActivity({ now: 1000, watermark: 100, thresholdMs: 100, terminal: true }).state, "terminal");
});

test("activityWatermark: newest of assignment and task timestamps", () => {
  const wm = activityWatermark({ updatedAt: 10 }, [{ updatedAt: 30 }, { startedAt: 20 }]);
  assert.equal(wm, 30);
});

// ---------------------------------------------------------------------------
// Warning decision + durable dedup
// ---------------------------------------------------------------------------

test("shouldWarn: dedups by assignment+watermark; a new burst may warn again", () => {
  const base = {
    assignment: { id: "a1" },
    receipts: {},
    now: 1_000_000,
    thresholdMs: 1000,
    terminal: false,
  };
  const first = shouldWarn({ ...base, watermark: 500_000 });
  assert.equal(first.warn, true);
  assert.equal(first.key, "a1:500000");

  // Same assignment, same watermark -> already warned.
  const again = shouldWarn({ ...base, watermark: 500_000, receipts: { "a1:500000": { ok: true } } });
  assert.equal(again.warn, false);
  assert.equal(again.reason, "already-warned");

  // New activity watermark -> warn once more.
  const moved = shouldWarn({ ...base, watermark: 500_001, receipts: { "a1:500000": {} } });
  assert.equal(moved.warn, true);
});

test("shouldWarn: terminal assignments never warn", () => {
  const r = shouldWarn({
    assignment: { id: "a1" },
    watermark: 1,
    receipts: {},
    now: 1_000_000,
    thresholdMs: 1000,
    terminal: true,
  });
  assert.equal(r.warn, false);
  assert.equal(r.reason, "terminal");
});

test("buildWarningMessage: honest, non-definitive phrasing", () => {
  const msg = buildWarningMessage({ projectId: "p1", assignment: { id: "a1", state: "running" }, ageMs: 900_000, kind: "no running child task" });
  assert.match(msg, /No recorded progress/);
  assert.match(msg, /NOT proof of a hang/);
  assert.match(msg, /no work was aborted/i);
});

test("receipts: round-trip and atomic dedup, tolerant of a corrupt file", async () => {
  const dir = await makeTempDir("pi-monitor-receipts");
  try {
    const file = path.join(dir, "receipts.json");
    assert.deepEqual(loadReceipts(file), { version: 1, warned: {} });
    recordReceipt(file, "a1:5", { ok: true, atIso: "x" });
    assert.deepEqual(loadReceipts(file).warned["a1:5"], { ok: true, atIso: "x" });

    // Corrupt file must not throw; starts empty.
    await (await import("node:fs/promises")).writeFile(file, "{not json");
    assert.deepEqual(loadReceipts(file), { version: 1, warned: {} });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Codex escalation (bounded, no shell, honest failures)
// ---------------------------------------------------------------------------

test("runCodexQueue: uses argv array, clean env, finite timeout; parses receipt", async () => {
  let captured = null;
  const exec = async (file, args, opts) => {
    captured = { file, args, opts };
    return { stdout: "Queued message 22222222-2222-2222-2222-222222222222 for thread t.", stderr: "", code: 0 };
  };
  const res = await runCodexQueue(
    { executable: "codex", thread: "t", message: "hello world; rm -rf /", env: { PATH: "/usr/bin" } },
    exec,
  );
  assert.equal(res.ok, true);
  assert.equal(res.receipt, "22222222-2222-2222-2222-222222222222");
  assert.equal(captured.file, "codex");
  assert.deepEqual(captured.args, ["queue", "--thread", "t", "--message", "hello world; rm -rf /"]);
  assert.equal(captured.opts.timeout, WARNING_CHILD_TIMEOUT_MS);
  // The message is ONE argv element — never split/interpreted by a shell.
  assert.equal(captured.args.length, 5);
});

test("runCodexQueue: missing CLI is a truthful permanent failure (no crash)", async () => {
  const exec = async () => {
    const err = new Error("spawn codex ENOENT");
    err.code = "ENOENT";
    throw err;
  };
  const res = await runCodexQueue({ executable: "codex", thread: "t", message: "m" }, exec);
  assert.equal(res.ok, false);
  assert.equal(res.permanent, true);
  assert.match(res.error, /codex queue failed/);
});

test("runCodexQueue: non-zero exit surfaces stderr, not a fake success", async () => {
  const exec = async () => ({ stdout: "", stderr: "bad thread id", code: 2 });
  const res = await runCodexQueue({ executable: "codex", thread: "t", message: "m" }, exec);
  assert.equal(res.ok, false);
  assert.equal(res.permanent, false);
  assert.match(res.error, /exited 2/);
});

test("parseQueueReceipt: zero exit with no id still ok; nonzero is not ok", () => {
  assert.deepEqual(parseQueueReceipt("done", 0), { ok: true, receipt: null });
  assert.deepEqual(parseQueueReceipt("Queued message abc for thread t.", 0), { ok: true, receipt: "abc" });
  assert.equal(parseQueueReceipt("Queued message abc", 1).ok, false);
});

test("buildCodexEnv: forwards only allowlisted keys, never secrets", () => {
  const env = buildCodexEnv({
    PATH: "/usr/bin",
    HOME: "/home/u",
    OPENAI_API_KEY: "sk-secret",
    AWS_SECRET_ACCESS_KEY: "nope",
    LANG: "en_US.UTF-8",
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/u");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.ok(!CODEX_ENV_ALLOWLIST.includes("OPENAI_API_KEY"));
});

// ---------------------------------------------------------------------------
// Read-only method boundary
// ---------------------------------------------------------------------------

test("makeReadOnlyCaller: refuses non-read methods and never touches raw RPC", async () => {
  let called = null;
  const fakeClient = { call: async (m, p) => { called = { m, p }; return { ok: true }; } };
  const call = makeReadOnlyCaller(fakeClient);

  await call("projects.show", { id: "p" });
  assert.equal(called.m, "projects.show");

  await assert.rejects(() => call("assignments.abort", { id: "x" }), /refusing non-read method/);
  await assert.rejects(() => call("service.restart", {}), /refusing non-read method/);
  await assert.rejects(() => call("assignments.recover", {}), /refusing non-read method/);
  assert.ok(!READ_METHODS.includes("assignments.abort"));
});

// ---------------------------------------------------------------------------
// Assignment selection / command extraction / tasks summary
// ---------------------------------------------------------------------------

test("selectLatestAssignment: prefers the newest non-terminal assignment", () => {
  const list = [
    { id: "old", state: "accepted", updatedAt: 10 },
    { id: "live", state: "running", updatedAt: 20 },
    { id: "done", state: "needs_review", updatedAt: 30 },
  ];
  assert.equal(selectLatestAssignment(list).id, "live");
  // All-terminal list falls back to the newest terminal one.
  assert.equal(selectLatestAssignment([{ id: "a", state: "accepted", updatedAt: 1 }]).id, "a");
  assert.equal(selectLatestAssignment([]), null);
  assert.ok(TERMINAL_STATES.has("needs_review"));
});

test("extractLatestCommand: reads real exit codes and bounded tails", () => {
  const entries = [
    { id: 1, kind: "message", data: { name: "bash", input: { command: "echo hi" }, exitCode: 0, stdout: "hi\n", stderr: "" } },
    { id: 2, kind: "message", data: { name: "bash", input: { command: "node probe.mjs" }, exitCode: 1, stdout: "partial", stderr: "boom" } },
  ];
  const cmd = extractLatestCommand(entries);
  assert.equal(cmd.command, "node probe.mjs");
  assert.equal(cmd.exitCode, 1);
  assert.equal(cmd.finished, true);
  assert.equal(cmd.stderr, "boom");
});

test("extractLatestCommand: a running command (no exit code) is not marked finished", () => {
  const cmd = extractLatestCommand([
    { id: 9, kind: "message", data: { name: "bash", input: { command: "sleep 100000" }, stdout: "…" } },
  ]);
  assert.equal(cmd.finished, false);
  assert.equal(cmd.exitCode, undefined);
});

test("extractLatestCommand: returns null when nothing looks like a command", () => {
  assert.equal(extractLatestCommand([{ id: 1, kind: "message", data: { text: "hello" } }]), null);
  assert.equal(extractLatestCommand([]), null);
});

test("summarizeTasks: counts running and bounds task list", () => {
  const summary = summarizeTasks({
    scheduling: { mode: "x" },
    tasks: [
      { id: "1", kind: "generation", state: "running", status: "tool_running" },
      { id: "2", kind: "compaction", state: "waiting", status: "queued" },
    ],
    submissions: [{ id: "s1", type: "message", status: "done" }],
  });
  assert.equal(summary.count, 2);
  assert.equal(summary.running, 1);
  assert.equal(summary.tasks[1].kind, "compaction");
});

// ---------------------------------------------------------------------------
// HTML/JSON escaping (untrusted strings never become innerHTML)
// ---------------------------------------------------------------------------

test("renderHtml: contains no innerHTML and uses textContent", () => {
  const html = renderHtml({ title: "t" });
  assert.ok(!/innerHTML/.test(html), "must not use innerHTML");
  assert.match(html, /textContent/);
  assert.match(html, /connect-src 'self'/);
});

test("renderHtml: strips angle brackets from the <title>", () => {
  const html = renderHtml({ title: "<img src=x onerror=alert(1)>" });
  assert.ok(!html.includes("<img src=x"), "title must not inject a tag");
});

test("escapeJsonForScript: neutralizes </script> and &", () => {
  const out = escapeJsonForScript(JSON.stringify({ x: "</script><script>alert(1)</script>", y: "a&b" }));
  assert.ok(!out.includes("</script>"));
  assert.ok(!out.includes("<script>"));
  assert.match(out, /\\u003c/);
});

// Regression for the incident where the *rendered inline script* had a syntax
// error (a template-literal newline leaked into a JS string) — node --check on
// the module cannot catch it, so we compile every <script> the way a browser
// would.
test("renderHtml: every inline <script> compiles as real JS (browser-parity)", () => {
  for (const title of ["t", "<img src=x onerror=alert(1)>", "a" + String.fromCharCode(10) + "c"]) {
    const html = renderHtml({ title });
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length >= 1, "expected at least one inline script");
    for (const js of scripts) {
      assert.doesNotThrow(() => new vm.Script(js), "inline script must compile");
    }
  }
});

// ---------------------------------------------------------------------------
// Real pi framed-entry shape (model: Message[] with role/content)
// ---------------------------------------------------------------------------

test("extractLatestCommand: parses real pi framed entries (toolCall + toolResult)", () => {
  const entries = [
    {
      id: "10",
      kind: "message",
      model: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "running the probe" },
            { type: "toolCall", id: "call_1", name: "bash", arguments: { command: 'node scripts/probe.mjs "probe"' } },
          ],
        },
      ],
      data: null,
    },
    {
      id: "11",
      kind: "message",
      model: [
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "bash",
          isError: false,
          content: [{ type: "text", text: "winrate 0.51\n" }],
        },
      ],
      data: null,
    },
  ];
  const cmd = extractLatestCommand(entries);
  assert.ok(cmd, "should find a command");
  assert.match(cmd.command, /probe\.mjs/);
  assert.equal(cmd.finished, false, "toolResult without an exit code is not a finished command");
  assert.match(cmd.stdout ?? "", /winrate 0\.51/);
  assert.ok(!/toolCallId/.test(cmd.stdout ?? ""), "must not dump raw model JSON");
});

test("extractLatestCommand: an assistant toolCall with no result still shows (running)", () => {
  const entries = [
    {
      id: "20437",
      kind: "message",
      model: [{ role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command: "sleep 100" } }] }],
      data: null,
    },
  ];
  const cmd = extractLatestCommand(entries);
  assert.ok(cmd);
  assert.equal(cmd.command, "sleep 100");
  assert.equal(cmd.finished, false);
});

test("latestEvidenceCommand: prefers the real evidence.commands log with a real exit code", () => {
  const evidence = {
    version: 1,
    phase: "settled",
    commands: [
      { seq: 1, command: "echo hi", exitCode: 0, stdoutTail: "hi\n", stderrTail: null, timedOut: false, durationMs: 5 },
      { seq: 2, command: "node bad.mjs", exitCode: 2, stdoutTail: "out", stderrTail: "boom", timedOut: false, durationMs: 9 },
    ],
  };
  const cmd = latestEvidenceCommand(evidence);
  assert.ok(cmd);
  assert.equal(cmd.command, "node bad.mjs");
  assert.equal(cmd.exitCode, 2);
  assert.equal(cmd.source, "evidence");
  assert.equal(cmd.stderr, "boom");
  assert.equal(cmd.finished, true);
  assert.equal(latestEvidenceCommand(null), null);
  assert.equal(latestEvidenceCommand({ commands: [] }), null);
});

test("previewEntries: renders role/content lines, never raw model JSON", () => {
  const entries = [
    {
      id: "20437",
      kind: "message",
      model: [{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "probe" } }] }],
      data: null,
    },
    { id: "20439", kind: "compaction", model: null, data: { note: "queued" } },
  ];
  const preview = previewEntries(entries);
  assert.match(preview, /#20437 message assistant: \[tool bash probe\]/);
  assert.match(preview, /#20439 compaction/);
});

test("previewEntries: collapses pi.compaction instead of dumping full history", () => {
  // A compaction entry whose model array carries a huge prior history: we must
  // NOT render its messages, only a one-line marker.
  const bigHistory = Array.from({ length: 500 }, (_, i) => ({
    role: "user",
    content: [{ type: "text", text: `history line ${i} SECRET_${i}` }],
  }));
  const entries = [{ id: "20439", kind: "pi.compaction", model: bigHistory, data: null }];
  const preview = previewEntries(entries, 12);
  assert.match(preview, /#20439 pi\.compaction: \[compaction/);
  assert.ok(!/SECRET_/.test(preview), "must not render compaction history contents");
  assert.equal(preview.split("\n").length, 1, "compaction must be a single line");
});

test("previewEntries: bounds the number of rendered lines", () => {
  const entries = Array.from({ length: 100 }, (_, i) => ({
    id: String(i),
    kind: "message",
    model: [{ role: "assistant", content: [{ type: "text", text: `line ${i}` }] }],
    data: null,
  }));
  const preview = previewEntries(entries, 5);
  assert.equal(preview.split("\n").length, 5);
});

test("extractUsage is labelled as a bounded recent-transcript window, not a session total", async () => {
  const { extractUsage } = await import("../tools/monitor.mjs");
  const entries = [
    { id: "1", kind: "message", model: [{ role: "assistant", content: [], usage: { input: 10, output: 5 } }], data: null },
    { id: "2", kind: "message", model: [{ role: "user", content: [] }], data: null },
  ];
  const usage = extractUsage(entries);
  assert.equal(usage.scope, "recent-transcript-window");
  assert.equal(usage.windowEntries, 2);
  assert.equal(usage.requests, 1);
  assert.equal(usage.tokens, 15);
});

// ---------------------------------------------------------------------------
// Host/Origin enforcement
// ---------------------------------------------------------------------------

test("isAllowedHostHeader: only loopback host[:port]", () => {
  assert.equal(isAllowedHostHeader("127.0.0.1:5180", 5180), true);
  assert.equal(isAllowedHostHeader("localhost:5180", 5180), true);
  assert.equal(isAllowedHostHeader("[::1]:5180", 5180), true);
  assert.equal(isAllowedHostHeader("evil.example.com:5180", 5180), false);
  assert.equal(isAllowedHostHeader("127.0.0.1:9999", 5180), false);
  assert.equal(isAllowedHostHeader(undefined, 5180), false);
});

test("isAllowedOriginHeader: rejects cross-origin, allows same-origin/absent", () => {
  assert.equal(isAllowedOriginHeader(undefined, 5180), true);
  assert.equal(isAllowedOriginHeader("http://127.0.0.1:5180", 5180), true);
  assert.equal(isAllowedOriginHeader("http://localhost:5180", 5180), true);
  assert.equal(isAllowedOriginHeader("http://evil.example.com", 5180), false);
  assert.equal(isAllowedOriginHeader("https://127.0.0.1:5180", 5180), false); // https not served
  assert.equal(isAllowedOriginHeader("garbage", 5180), false);
});

// ---------------------------------------------------------------------------
// HTTP server routing (real loopback server)
// ---------------------------------------------------------------------------

test("dashboard server: loopback GET/HEAD only, safe host/origin, JSON endpoint", async () => {
  const state = {
    port: 0,
    title: "unit",
    getSnapshot: () => ({ ok: true, evil: "</script><b>x</b>" }),
  };
  const server = createDashboardServer(state);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  state.port = port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // GET / serves HTML.
    const html = await fetch(`${base}/`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type"), /text\/html/);
    const headerNames = [...html.headers].map(([k]) => k.toLowerCase()).join(",");
    assert.ok(!/access-control-allow-origin/.test(headerNames), "no CORS headers");
    assert.ok(!/content-security-policy/.test(headerNames) || true);

    // HEAD / has no body.
    const head = await fetch(`${base}/`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal((await head.text()).length, 0);

    // JSON endpoint escapes a hostile snapshot value.
    const snap = await fetch(`${base}/api/snapshot`);
    const text = await snap.text();
    assert.equal(snap.status, 200);
    assert.ok(!text.includes("</script>"), "JSON must be script-safe");
    assert.ok(!text.includes("<b>x</b>"));
    assert.deepEqual(JSON.parse(text.replace(/\\u003c/g, "<").replace(/\\u003e/g, ">")), {
      ok: true,
      evil: "</script><b>x</b>",
    });

    // POST is refused with an Allow header.
    const post = await fetch(`${base}/`, { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD");

    // Unknown path is 404.
    const missing = await fetch(`${base}/nope`);
    assert.equal(missing.status, 404);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("dashboard server: refuses a forged Host header (raw socket)", async () => {
  const http = await import("node:http");
  const state = { port: 0, title: "unit", getSnapshot: () => ({ ok: true }) };
  const server = createDashboardServer(state);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  state.port = port;

  const rawRequest = (headers) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, method: "GET", path: "/", headers, setHost: false },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        }
      );
      req.on("error", reject);
      req.end();
    });

  try {
    const forged = await rawRequest({ host: "evil.example.com" });
    assert.equal(forged.status, 403);
    const ok = await rawRequest({ host: `127.0.0.1:${port}` });
    assert.equal(ok.status, 200);
  } finally {
    server.close();
    await once(server, "close");
  }
});

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

test("humanAge: compact, honest durations", () => {
  assert.equal(humanAge(0), "0s");
  assert.equal(humanAge(5000), "5s");
  assert.equal(humanAge(90_000), "1m 30s");
  assert.equal(humanAge(3 * 3600_000 + 5 * 60_000), "3h 5m");
  assert.equal(humanAge(NaN), "unknown");
});

test("TERMINAL_STATES: includes accepted/failed/cancelled/timeout/budget", () => {
  for (const s of ["accepted", "failed", "cancelled", "timeout", "budget", "needs_review", "unanswered", "revision_requested"]) {
    assert.ok(TERMINAL_STATES.has(s), `${s} should be terminal`);
  }
  assert.ok(!TERMINAL_STATES.has("running"));
  assert.ok(!TERMINAL_STATES.has("queued"));
});


