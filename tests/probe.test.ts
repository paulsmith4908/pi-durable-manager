import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";

import {
  buildInstruction,
  inspectEntries,
  main,
  parseProbeArgs,
  ProbeError,
  PROBE_TOOL_NAME,
  runProbe,
  type ProbeHost,
} from "../src/probe.js";
import type { PiDurableConfig } from "../src/config.js";
import type { ResolvedCredential } from "../src/credential.js";

const NONCE = "nonce-abc-123";
const FAKE_KEY = "sk-this-is-a-fake-key-not-real-0000";
const SUPER_SECRET = "super-secret-value-9f8e7d6c";

/** Build a config object pointing at a throwaway absolute state dir. */
function makeConfig(stateDir: string): PiDurableConfig {
  return {
    configVersion: 1,
    endpoint: "https://inference.example.invalid/v1",
    model: "deepseek-ai/DeepSeek-V4.1-Flash",
    limits: { contextWindow: 65536, maxTokens: 8192, maxSteps: 40, timeoutMs: 30000 },
    paths: { stateDir, projectHome: stateDir, allowedRoots: [stateDir] },
    credential: { env: "PI_DURABLE_TEST_KEY_UNUSED" },
  };
}

/**
 * Build a `ProbeHost` backed by the real faux provider. The scripted responses
 * are a tool call followed by a final assistant text echoing the nonce, which
 * is exactly what a correct run must produce.
 */
function makeFauxHost(options?: {
  responses?: ReturnType<typeof fauxAssistantMessage>[];
  providerId?: string;
  modelId?: string;
}): { host: ProbeHost; providerId: string; state: { callCount: number } } {
  const faux = fauxProvider({
    provider: options?.providerId ?? "faux",
    models: [{ id: options?.modelId ?? "deepseek-ai/DeepSeek-V4.1-Flash" }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    options?.responses ?? [
      fauxAssistantMessage(fauxToolCall(PROBE_TOOL_NAME, { nonce: NONCE }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(`nonce=${NONCE}`, { stopReason: "stop" }),
    ],
  );
  const host: ProbeHost = {
    providerId: faux.provider.id,
    nonce: NONCE,
    createModels: () => models,
    resolveCredential: async (): Promise<ResolvedCredential> => ({
      apiKey: FAKE_KEY,
      source: "test",
    }),
  };
  return { host, providerId: faux.provider.id, state: faux.state };
}

/** Write a portable config file and return its path. */
async function writeConfig(dir: string, config: PiDurableConfig): Promise<string> {
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify(config));
  return path;
}

test("parseProbeArgs accepts --state-dir with --config and requires it for legacy", () => {
  const parsed = parseProbeArgs(["--config", "c.json", "--state-dir", "/tmp/x", "--timeout-ms", "5000"]);
  assert.equal(parsed.configFile, "c.json");
  assert.equal(parsed.stateDir, "/tmp/x");
  assert.equal(parsed.timeoutMs, 5000);

  assert.throws(() => parseProbeArgs(["--legacy-config", "l.json"]), ProbeError);
  assert.throws(() => parseProbeArgs(["--config", "a", "--legacy-config", "b", "--state-dir", "/x"]), ProbeError);
  assert.throws(() => parseProbeArgs(["--config", "a", "--timeout-ms", "0"]), ProbeError);
  assert.throws(() => parseProbeArgs(["--nope"]), ProbeError);
});

test("inspectEntries iterates the model ARRAY and requires a final stop echoing the nonce", () => {
  // EntryRecord.model is an array of messages; a single entry contributes both
  // the tool-call assistant and the final assistant.
  const entries = [
    {
      id: "e1",
      conversationId: "c1",
      kind: "pi.user",
      model: [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 }],
    },
    {
      id: "e2",
      conversationId: "c1",
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "t1", name: PROBE_TOOL_NAME, arguments: { nonce: NONCE } }],
          stopReason: "toolUse",
        },
        {
          role: "assistant",
          content: [{ type: "text", text: `nonce=${NONCE}` }],
          stopReason: "stop",
        },
      ],
    },
  ] as never;
  const info = inspectEntries(entries, NONCE);
  assert.equal(info.toolCalls, 1);
  assert.equal(info.stopReason, "stop");
  assert.equal(info.stopped, true);
  assert.equal(info.echoedNonce, true);
});

test("inspectEntries rejects a final toolUse and a missing nonce echo", () => {
  const toolUseOnly = [
    {
      id: "e1",
      conversationId: "c1",
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "t1", name: PROBE_TOOL_NAME, arguments: { nonce: NONCE } }],
          stopReason: "toolUse",
        },
      ],
    },
  ] as never;
  const a = inspectEntries(toolUseOnly, NONCE);
  assert.equal(a.stopped, false);
  assert.equal(a.echoedNonce, false);

  const noEcho = [
    {
      id: "e1",
      conversationId: "c1",
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          content: [{ type: "text", text: "done, no nonce here" }],
          stopReason: "stop",
        },
      ],
    },
  ] as never;
  const b = inspectEntries(noEcho, NONCE);
  assert.equal(b.stopped, true);
  assert.equal(b.echoedNonce, false);
});

test("runProbe succeeds against real SQLite + faux provider and is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "probe-ok-"));
  const config = makeConfig(dir);
  const { host, providerId } = makeFauxHost();
  const configPath = await writeConfig(dir, config);

  const result = await runProbe({ configFile: configPath, timeoutMs: 10000 }, host);

  assert.equal(result.ok, true, result.error);
  assert.equal(result.toolCalls, 1);
  assert.equal(result.stopReason, "stop");
  assert.equal(result.reopened, true);
  assert.equal(result.idempotent, true);
  assert.ok(result.requestId.startsWith("pi-durable-probe-"));
  assert.ok(result.conversationId.length > 0);
  assert.ok(result.submissionId.length > 0);
  assert.equal(providerId, host.providerId);

  // No secret material in the serialized result.
  const json = JSON.stringify(result);
  assert.doesNotMatch(json, /sk-this-is-a-fake-key/);
  assert.doesNotMatch(json, new RegExp(SUPER_SECRET));
});

test("runProbe requestId is unique per run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "probe-unique-"));
  const configPath = await writeConfig(dir, makeConfig(dir));
  const a = await runProbe({ configFile: configPath, timeoutMs: 10000 }, makeFauxHost().host);
  const b = await runProbe({ configFile: configPath, timeoutMs: 10000 }, makeFauxHost().host);
  assert.notEqual(a.requestId, b.requestId);
});

test("runProbe does NOT treat a final toolUse as success", async () => {
  const dir = await mkdtemp(join(tmpdir(), "probe-tooluse-"));
  const configPath = await writeConfig(dir, makeConfig(dir));
  const { host } = makeFauxHost({
    responses: [
      fauxAssistantMessage(fauxToolCall(PROBE_TOOL_NAME, { nonce: NONCE }), {
        stopReason: "toolUse",
      }),
    ],
  });

  const result = await runProbe({ configFile: configPath, timeoutMs: 10000 }, host);
  assert.equal(result.ok, false);
  assert.notEqual(result.stopReason, "stop");
  assert.ok(result.error);
});

test("runProbe does NOT treat a STOP without the nonce echo as success", async () => {
  const dir = await mkdtemp(join(tmpdir(), "probe-noecho-"));
  const configPath = await writeConfig(dir, makeConfig(dir));
  const { host } = makeFauxHost({
    responses: [
      fauxAssistantMessage(fauxToolCall(PROBE_TOOL_NAME, { nonce: NONCE }), { stopReason: "toolUse" }),
      fauxAssistantMessage("all done", { stopReason: "stop" }),
    ],
  });

  const result = await runProbe({ configFile: configPath, timeoutMs: 10000 }, host);
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, "stop");
});

test("runProbe fails, aborts, and cleans up on timeout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "probe-timeout-"));
  const configPath = await writeConfig(dir, makeConfig(dir));
  // A factory that never settles: the run must time out and still clean up.
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "deepseek-ai/DeepSeek-V4.1-Flash" }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    () => new Promise(() => {
      /* never resolves */
    }),
  ] as never);
  const host: ProbeHost = {
    providerId: faux.provider.id,
    nonce: NONCE,
    createModels: () => models,
    resolveCredential: async () => ({ apiKey: FAKE_KEY, source: "test" }),
  };

  const result = await runProbe({ configFile: configPath, timeoutMs: 500 }, host);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /timed out/i);

  // Cleanup must have run: the ownership lock is gone, so a later run would be
  // free to acquire it.
  await assert.rejects(readFile(resolve(dir, "probe.lock")));
});

test("runProbe refuses a state dir that is locked by a live process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "probe-locked-"));
  const configPath = await writeConfig(dir, makeConfig(dir));

  // Simulate a live owner: name a real, running process other than this one.
  // `process.ppid` (the test runner's parent) is alive but is a different PID,
  // so the lock must be treated as live and refused, not reclaimed.
  await writeFile(resolve(dir, "probe.lock"), String(process.ppid));
  const result = await runProbe({ configFile: configPath, timeoutMs: 10000 }, makeFauxHost().host);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /in use/i);
});

test("runProbe clears a stale lock owned by a dead process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "probe-stale-"));
  const configPath = await writeConfig(dir, makeConfig(dir));

  // A PID that is exceedingly unlikely to be alive.
  await writeFile(resolve(dir, "probe.lock"), "2147483646");
  const result = await runProbe({ configFile: configPath, timeoutMs: 10000 }, makeFauxHost().host);
  assert.equal(result.ok, true, result.error);
});

test("runProbe creates the state directory with private permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "probe-perms-"));
  const stateDir = join(dir, "private-state");
  const configPath = await writeConfig(dir, makeConfig(stateDir));

  const result = await runProbe({ configFile: configPath, timeoutMs: 10000 }, makeFauxHost().host);
  assert.equal(result.ok, true, result.error);

  const info = await stat(stateDir);
  // Owner-only: no group/other bits.
  assert.equal(info.mode & 0o077, 0);
  // The lock is gone after a clean run.
  await assert.rejects(readFile(resolve(stateDir, "probe.lock")));
});

test("main prints one JSON line and returns a non-zero code on failure", async () => {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown as (chunk: string) => boolean) = (chunk: string) => {
    chunks.push(chunk);
    return true;
  };
  try {
    // No config file at all -> usage failure, no network.
    const code = await main([]);
    assert.equal(code, 1);
  } finally {
    (process.stdout.write as unknown as (chunk: string) => boolean) = original as never;
  }
  const line = chunks.join("");
  assert.equal(line.trimEnd().split("\n").length, 1);
  const parsed = JSON.parse(line) as { ok: boolean; error: string };
  assert.equal(parsed.ok, false);
  assert.ok(parsed.error.length > 0);
});

test("buildInstruction names the tool and the nonce", () => {
  const text = buildInstruction(NONCE);
  assert.match(text, new RegExp(PROBE_TOOL_NAME));
  assert.match(text, new RegExp(`nonce="${NONCE}"`));
  assert.match(text, new RegExp(`nonce=${NONCE}`));
});
