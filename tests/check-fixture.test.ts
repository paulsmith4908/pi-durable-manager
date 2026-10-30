// Tests for src/check-fixture.ts — the deterministic loopback OpenAI-compatible
// fixture provider used by the offline end-to-end check.
//
// These tests dial the fixture over REAL HTTP (no mocking) and assert:
//  - the server binds loopback on an ephemeral port;
//  - it answers `POST /v1/chat/completions` with a well-formed SSE stream;
//  - the scripted turn sequence is deterministic (write → bash → final text);
//  - it records every request so the check can prove the transport dialed it;
//  - unknown routes 404 and `close()` frees the port.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";

import {
  FIXTURE_FILE_CONTENT,
  FIXTURE_FILE_NAME,
  FIXTURE_TEST_COMMAND,
  startFixtureServer,
  type FixtureServer,
} from "../src/check-fixture.js";

const running: FixtureServer[] = [];
after(async () => {
  for (const s of running) {
    await s.close().catch(() => undefined);
  }
});

async function start(): Promise<FixtureServer> {
  const s = await startFixtureServer();
  running.push(s);
  return s;
}

interface HttpResult {
  status: number;
  body: string;
}

function postJson(url: string, payload: unknown): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(payload);
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

function get(url: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest({ hostname: u.hostname, port: u.port, path: u.pathname, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Extract the SSE `data:` JSON payloads (excluding the terminating [DONE]). */
function sseObjects(body: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice("data:".length).trim();
    if (payload === "[DONE]") continue;
    out.push(JSON.parse(payload) as Record<string, unknown>);
  }
  return out;
}

interface ToolCallDelta {
  choices?: { delta?: { tool_calls?: { function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[];
}

function collectToolCalls(objs: Record<string, unknown>[]): { name: string; args: string }[] {
  const calls: { name: string; args: string }[] = [];
  let current: { name: string; args: string } | undefined;
  for (const o of objs as unknown as ToolCallDelta[]) {
    const tc = o.choices?.[0]?.delta?.tool_calls?.[0];
    if (tc?.function?.name !== undefined) {
      if (current !== undefined) calls.push(current);
      current = { name: tc.function.name, args: "" };
    }
    if (tc?.function?.arguments !== undefined && current !== undefined) {
      current.args += tc.function.arguments;
    }
  }
  if (current !== undefined) calls.push(current);
  return calls;
}

test("fixture server binds loopback and exposes a /v1 base URL", async () => {
  const s = await start();
  assert.match(s.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  assert.ok(s.port > 0, "ephemeral port assigned");
});

test("first turn streams a real `write` tool call for the fixture file", async () => {
  const s = await start();
  const res = await postJson(`${s.baseUrl}/chat/completions`, {
    model: "fixture-model",
    messages: [{ role: "user", content: "go" }],
    stream: true,
  });
  assert.equal(res.status, 200);
  assert.match(res.body, /data: \[DONE\]/);
  const objs = sseObjects(res.body);
  const calls = collectToolCalls(objs);
  assert.equal(calls.length, 1, "exactly one tool call");
  assert.equal(calls[0]?.name, "write");
  const args = JSON.parse(calls[0]?.args ?? "{}") as { path?: string; content?: string };
  assert.equal(args.path, FIXTURE_FILE_NAME);
  assert.equal(args.content, FIXTURE_FILE_CONTENT);
  assert.equal(s.requestCount(), 1);
});

test("second turn streams a real `bash` tool call running the test command", async () => {
  const s = await start();
  await postJson(`${s.baseUrl}/chat/completions`, { model: "m", messages: [], stream: true });
  const res = await postJson(`${s.baseUrl}/chat/completions`, { model: "m", messages: [], stream: true });
  const calls = collectToolCalls(sseObjects(res.body));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "bash");
  const args = JSON.parse(calls[0]?.args ?? "{}") as { command?: string };
  assert.equal(args.command, FIXTURE_TEST_COMMAND);
});

test("third and later turns are a final assistant message with no tool calls", async () => {
  const s = await start();
  await postJson(`${s.baseUrl}/chat/completions`, { model: "m", messages: [], stream: true });
  await postJson(`${s.baseUrl}/chat/completions`, { model: "m", messages: [], stream: true });
  for (let i = 0; i < 3; i += 1) {
    const res = await postJson(`${s.baseUrl}/chat/completions`, { model: "m", messages: [], stream: true });
    const objs = sseObjects(res.body);
    assert.equal(collectToolCalls(objs).length, 0, "no tool calls after the scripted turns");
    const text = objs
      .map((o) => (o.choices as { delta?: { content?: string } }[] | undefined)?.[0]?.delta?.content ?? "")
      .join("");
    assert.match(text, /complete/i);
  }
});

test("records model + tool names per request, and 404s unknown routes", async () => {
  const s = await start();
  await postJson(`${s.baseUrl}/chat/completions`, {
    model: "fixture-model",
    messages: [{ role: "user", content: "x" }],
    tools: [{ type: "function", function: { name: "write" } }],
    stream: true,
  });
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0]?.model, "fixture-model");
  assert.deepEqual(s.requests[0]?.toolNames, ["write"]);

  const missing = await get(`${s.baseUrl}/models`);
  assert.equal(missing.status, 404);
});

test("close() frees the port so a fresh server can bind", async () => {
  const s = await startFixtureServer();
  await s.close();
  // A subsequent independent server starts fine (no leaked listener).
  const s2 = await start();
  assert.ok(s2.port > 0);
});
