//
// release-polish/tests/cli-status.test.mjs
//
// Focused, hermetic tests for the release-polish CLI verdict/envelope helpers.
//
// These exercise the release-critical logic WITHOUT a live daemon, sockets, or
// the main-only modules (`client.ts`, `config.ts`, ...): the pure helpers live in
// `src/cli-status.ts`, which imports nothing but types. That keeps the verdicts
// (`status` running/stopped, `doctor` ok) unit-testable in isolation. We import
// the COMPILED module (`dist/cli-status.js`) exactly like the other repo tests,
// so the focused assertions run against the same artifact the CLI ships.
//
//   npm run build && node --test tests-assets/cli-status.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyStatusError,
  doctorOk,
  errorEnvelope,
  okEnvelope,
  parseEnvelope,
  serializeEnvelope,
} from "../dist/cli-status.js";

test("status: a genuinely missing socket is a clean not-running result", () => {
  assert.deepEqual(classifyStatusError("ENOENT"), { ok: true, running: false, code: "no_socket" });
  assert.deepEqual(classifyStatusError("ENOTDIR"), { ok: true, running: false, code: "no_socket" });
});

test("status: a stale socket (refused listener) is NOT a success", () => {
  // The classic false-success bug: the socket file exists but nothing listens.
  for (const code of ["ECONNREFUSED", "ECONNRESET", "ENOTSOCK", "EHOSTUNREACH"]) {
    const verdict = classifyStatusError(code);
    assert.equal(verdict.ok, false, `${code} must not be ok:true`);
    assert.equal(verdict.code, "stale_socket");
  }
});

test("status: permission errors are reported, never silently treated as stopped", () => {
  for (const code of ["EACCES", "EPERM"]) {
    const verdict = classifyStatusError(code);
    assert.equal(verdict.ok, false, `${code} must not be ok:true`);
    assert.equal(verdict.code, "permission");
  }
});

test("status: unknown/protocol failures are conservative failures, not successes", () => {
  for (const code of [undefined, "EPROTO", "ETIMEDOUT", "WEIRD"]) {
    const verdict = classifyStatusError(code);
    assert.equal(verdict.ok, false, `${String(code)} must not be ok:true`);
    assert.equal(verdict.code, "unreachable");
  }
});

test("doctor: ok requires Node, platform, sandbox-exec, present AND valid config", () => {
  const good = {
    nodeOk: true,
    platformOk: true,
    sandboxExecAvailable: true,
    configPresent: true,
    configOk: true,
  };
  assert.equal(doctorOk(good), true);
  // Any single failed precondition must flip the verdict to false.
  for (const key of Object.keys(good)) {
    assert.equal(doctorOk({ ...good, [key]: false }), false, `${key}=false must be ok:false`);
  }
});

test("doctor: an invalid config is a failure even when the file exists", () => {
  // configPresent:true + configOk:false models "file exists but load/validate threw".
  assert.equal(
    doctorOk({
      nodeOk: true,
      platformOk: true,
      sandboxExecAvailable: true,
      configPresent: true,
      configOk: false,
    }),
    false,
  );
});

test("envelope: ok and error envelopes match the documented shape", () => {
  assert.deepEqual(okEnvelope({ running: true }), { ok: true, result: { running: true } });
  assert.deepEqual(errorEnvelope("usage", "bad flag"), {
    ok: false,
    error: { code: "usage", message: "bad flag" },
  });
});

test("envelope: serialize emits exactly one newline-terminated JSON object", () => {
  const line = serializeEnvelope(okEnvelope({ a: 1 }));
  assert.equal(line.endsWith("\n"), true);
  assert.equal(line.indexOf("\n"), line.length - 1, "must be a single line");
  assert.deepEqual(JSON.parse(line), { ok: true, result: { a: 1 } });
});

test("envelope: parseEnvelope round-trips and rejects non-envelopes", () => {
  assert.deepEqual(parseEnvelope(serializeEnvelope(okEnvelope(3))), { ok: true, result: 3 });
  assert.deepEqual(parseEnvelope(serializeEnvelope(errorEnvelope("x", "y"))), {
    ok: false,
    error: { code: "x", message: "y" },
  });
  // Rejections: not JSON, not an object, missing `ok`, malformed error.
  assert.equal(parseEnvelope("plain help text"), null);
  assert.equal(parseEnvelope("[]"), null);
  assert.equal(parseEnvelope("42"), null);
  assert.equal(parseEnvelope('{"result":1}'), null);
  assert.equal(parseEnvelope('{"ok":false}'), null);
  assert.equal(parseEnvelope('{"ok":false,"error":{"code":1,"message":"m"}}'), null);
});

test("envelope: a help payload is a valid, parseable JSON envelope", () => {
  // Mirrors cli.ts helpEnvelope(): `--help --json` must be one valid envelope.
  const help = okEnvelope({ help: "usage: pi-durable ...\n" });
  const parsed = parseEnvelope(serializeEnvelope(help));
  assert.notEqual(parsed, null);
  assert.equal(parsed.ok, true);
  assert.equal(typeof parsed.result.help, "string");
});
