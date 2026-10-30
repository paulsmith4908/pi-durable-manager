import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadConfig,
  loadLegacyConfig,
  validateEndpoint,
  ConfigError,
} from "../src/config.js";

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pdm-config-"));
}

const VALID = {
  configVersion: 1,
  endpoint: "https://inference.example.invalid/v1",
  model: "example-model-id",
  limits: { contextWindow: 65536, maxTokens: 8192, maxSteps: 40, timeoutMs: 1800000 },
  paths: { stateDir: "./state", projectHome: "./projects", allowedRoots: ["./projects"] },
  credential: { env: "PI_DURABLE_API_KEY" },
};

async function writeConfig(dir: string, value: unknown, name = "config.json"): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, JSON.stringify(value), "utf8");
  return p;
}

test("loadConfig accepts a valid config and resolves relative paths vs config dir", async () => {
  const dir = await makeDir();
  try {
    const path = await writeConfig(dir, VALID);
    const config = await loadConfig(path);
    assert.equal(config.configVersion, 1);
    assert.equal(config.endpoint, VALID.endpoint);
    assert.equal(config.model, "example-model-id");
    assert.equal(config.paths.stateDir, join(dir, "state"));
    assert.equal(config.paths.projectHome, join(dir, "projects"));
    assert.deepEqual(config.paths.allowedRoots, [join(dir, "projects")]);
    assert.equal(config.credential.env, "PI_DURABLE_API_KEY");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig resolves apiKeyFile relative to the config file", async () => {
  const dir = await makeDir();
  try {
    const cfg = { ...VALID, credential: { apiKeyFile: "./secrets/key.txt" } };
    const path = await writeConfig(dir, cfg);
    const config = await loadConfig(path);
    assert.equal(config.credential.apiKeyFile, join(dir, "secrets", "key.txt"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects loopback-disallowed non-HTTPS endpoints", async () => {
  const dir = await makeDir();
  try {
    const cfg = { ...VALID, endpoint: "http://remote.example.com/v1" };
    const path = await writeConfig(dir, cfg);
    await assert.rejects(loadConfig(path), (e: unknown) => e instanceof ConfigError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig allows http loopback endpoints (test fixtures)", async () => {
  const dir = await makeDir();
  try {
    for (const endpoint of ["http://127.0.0.1:8080/v1", "http://localhost:1234/v1", "http://[::1]:9/v1"]) {
      const cfg = { ...VALID, endpoint };
      const path = await writeConfig(dir, cfg, `c-${Math.random().toString(36).slice(2)}.json`);
      const config = await loadConfig(path);
      assert.equal(config.endpoint, endpoint);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects missing configVersion", async () => {
  const dir = await makeDir();
  try {
    const { configVersion: _drop, ...rest } = VALID;
    const path = await writeConfig(dir, rest);
    await assert.rejects(loadConfig(path), (e: unknown) => e instanceof ConfigError && e.code === "version");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects invalid limits", async () => {
  const dir = await makeDir();
  try {
    const cfg = { ...VALID, limits: { ...VALID.limits, maxSteps: 0 } };
    const path = await writeConfig(dir, cfg);
    await assert.rejects(loadConfig(path), (e: unknown) => e instanceof ConfigError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig: maxSteps/timeoutMs null means UNLIMITED and is preserved", async () => {
  const dir = await makeDir();
  try {
    const cfg = { ...VALID, limits: { ...VALID.limits, maxSteps: null, timeoutMs: null } };
    const path = await writeConfig(dir, cfg);
    const config = await loadConfig(path);
    assert.equal(config.limits.maxSteps, null, "explicit null maxSteps must survive as unlimited");
    assert.equal(config.limits.timeoutMs, null, "explicit null timeoutMs must survive as unlimited");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig: omitted maxSteps/timeoutMs resolve to UNLIMITED (null)", async () => {
  const dir = await makeDir();
  try {
    const { contextWindow, maxTokens } = VALID.limits;
    const cfg = { ...VALID, limits: { contextWindow, maxTokens } };
    const path = await writeConfig(dir, cfg);
    const config = await loadConfig(path);
    assert.equal(config.limits.maxSteps, null, "omitted maxSteps => unlimited");
    assert.equal(config.limits.timeoutMs, null, "omitted timeoutMs => unlimited");
    // Generation constraints stay finite.
    assert.equal(config.limits.contextWindow, 65536);
    assert.equal(config.limits.maxTokens, 8192);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig: positive finite maxSteps/timeoutMs remain valid (backward compatible)", async () => {
  const dir = await makeDir();
  try {
    const cfg = { ...VALID, limits: { ...VALID.limits, maxSteps: 300, timeoutMs: 1_200_000 } };
    const path = await writeConfig(dir, cfg);
    const config = await loadConfig(path);
    assert.equal(config.limits.maxSteps, 300);
    assert.equal(config.limits.timeoutMs, 1_200_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects zero/negative/fractional limits", async () => {
  const dir = await makeDir();
  try {
    for (const bad of [0, -1, 1.5]) {
      for (const key of ["maxSteps", "timeoutMs"] as const) {
        const cfg = { ...VALID, limits: { ...VALID.limits, [key]: bad } };
        const path = await writeConfig(
          dir,
          cfg,
          `c-${key}-${String(bad)}-${Math.random().toString(36).slice(2)}.json`,
        );
        await assert.rejects(
          loadConfig(path),
          (e: unknown) => e instanceof ConfigError,
          `${key}=${String(bad)} must be rejected`,
        );
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects non-finite limit literals written as raw tokens", async () => {
  // JSON cannot natively encode NaN/Infinity, so a hand-written config that
  // smuggles them as bare tokens must still be rejected by the parser/validator.
  const dir = await makeDir();
  try {
    for (const key of ["maxSteps", "timeoutMs"] as const) {
      const name = `raw-${key}.json`;
      const raw = JSON.stringify(VALID).replace(key === "maxSteps" ? "40" : "1800000", "Infinity");
      await writeFile(join(dir, name), raw, "utf8");
      await assert.rejects(
        loadConfig(join(dir, name)),
        (e: unknown) => e instanceof ConfigError,
        `${key}=Infinity must be rejected`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig: tools.commandTimeoutMs defaults to null and accepts a finite cap", async () => {
  const dir = await makeDir();
  try {
    const omitted = await writeConfig(dir, VALID, "omitted.json");
    assert.equal((await loadConfig(omitted)).tools?.commandTimeoutMs ?? null, null);

    const nulled = await writeConfig(dir, { ...VALID, tools: { commandTimeoutMs: null } }, "null.json");
    assert.equal((await loadConfig(nulled)).tools?.commandTimeoutMs, null);

    const finite = await writeConfig(dir, { ...VALID, tools: { commandTimeoutMs: 45000 } }, "finite.json");
    assert.equal((await loadConfig(finite)).tools?.commandTimeoutMs, 45000);

    const bad = await writeConfig(dir, { ...VALID, tools: { commandTimeoutMs: 0 } }, "bad.json");
    await assert.rejects(loadConfig(bad), (e: unknown) => e instanceof ConfigError);

    const overflow = await writeConfig(
      dir,
      { ...VALID, tools: { commandTimeoutMs: 2_147_483_648 } },
      "overflow.json",
    );
    await assert.rejects(
      loadConfig(overflow),
      (e: unknown) => e instanceof ConfigError,
      "a duration beyond Node's timer range must be rejected, not silently clamped",
    );

    const overflowLimit = await writeConfig(
      dir,
      { ...VALID, limits: { ...VALID.limits, timeoutMs: 2_147_483_648 } },
      "overflow-limit.json",
    );
    await assert.rejects(loadConfig(overflowLimit), (e: unknown) => e instanceof ConfigError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects credential with neither apiKeyFile nor env", async () => {
  const dir = await makeDir();
  try {
    const cfg = { ...VALID, credential: {} };
    const path = await writeConfig(dir, cfg);
    await assert.rejects(loadConfig(path), (e: unknown) => e instanceof ConfigError && e.code === "credential");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects credential with both apiKeyFile and env", async () => {
  const dir = await makeDir();
  try {
    const cfg = { ...VALID, credential: { apiKeyFile: "./k", env: "X" } };
    const path = await writeConfig(dir, cfg);
    await assert.rejects(loadConfig(path), (e: unknown) => e instanceof ConfigError && e.code === "credential");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig does not embed raw config or secrets in error messages", async () => {
  const dir = await makeDir();
  try {
    const cfg = {
      ...VALID,
      credential: { env: "PI_DURABLE_API_KEY" },
      compat: { thinkingFormat: "sk-not-a-real-format-token" },
    };
    const path = await writeConfig(dir, cfg);
    const error = await loadConfig(path).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    assert.ok(error);
    assert.doesNotMatch(error.message, /sk-not-a-real/);
    assert.doesNotMatch(error.message, /"configVersion"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig accepts validated compat overrides", async () => {
  const dir = await makeDir();
  try {
    const cfg = { ...VALID, compat: { thinkingFormat: "deepseek", maxTokensField: "max_tokens", supportsStore: false } };
    const path = await writeConfig(dir, cfg);
    const config = await loadConfig(path);
    assert.equal(config.compat?.thinkingFormat, "deepseek");
    assert.equal(config.compat?.supportsStore, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects unknown compat field", async () => {
  const dir = await makeDir();
  try {
    const cfg = { ...VALID, compat: { notAField: true } };
    const path = await writeConfig(dir, cfg);
    await assert.rejects(loadConfig(path), (e: unknown) => e instanceof ConfigError && e.code === "compat");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects invalid thinkingFormat", async () => {
  const dir = await makeDir();
  try {
    const cfg = { ...VALID, compat: { thinkingFormat: "unsupported-format" } };
    const path = await writeConfig(dir, cfg);
    await assert.rejects(loadConfig(path), (e: unknown) => e instanceof ConfigError && e.code === "compat");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadLegacyConfig maps legacy fields and keeps runtime state separate", async () => {
  const dir = await makeDir();
  try {
    const legacy = {
      baseUrl: "https://legacy.example.invalid/v1",
      model: "legacy-model",
      apiKeyFile: "./key.txt",
      contextTokens: 32768,
      outputTokens: 4096,
      allowedProjects: ["./projects"],
    };
    const path = await writeConfig(dir, legacy, "legacy.json");
    const config = await loadLegacyConfig(path, { stateDir: "./rt-state", projectHome: "./rt-home" });
    assert.equal(config.endpoint, "https://legacy.example.invalid/v1");
    assert.equal(config.model, "legacy-model");
    assert.equal(config.limits.contextWindow, 32768);
    assert.equal(config.limits.maxTokens, 4096);
    assert.equal(config.credential.apiKeyFile, join(dir, "key.txt"));
    assert.equal(config.paths.stateDir, join(dir, "rt-state"));
    assert.equal(config.paths.projectHome, join(dir, "rt-home"));
    assert.deepEqual(config.paths.allowedRoots, [join(dir, "projects")]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadLegacyConfig prefers explicit credential override", async () => {
  const dir = await makeDir();
  try {
    const legacy = {
      baseUrl: "https://legacy.example.invalid/v1",
      model: "legacy-model",
      apiKeyFile: "./legacy-key.txt",
      contextTokens: 32768,
      outputTokens: 4096,
      allowedProjects: [],
    };
    const path = await writeConfig(dir, legacy, "legacy.json");
    const config = await loadLegacyConfig(path, { credential: { env: "OVERRIDE_KEY" } });
    assert.equal(config.credential.env, "OVERRIDE_KEY");
    assert.equal(config.credential.apiKeyFile, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validateEndpoint enforces https/loopback rules", () => {
  assert.doesNotThrow(() => validateEndpoint("https://x.example/v1"));
  assert.doesNotThrow(() => validateEndpoint("http://127.0.0.1:1/v1"));
  assert.throws(() => validateEndpoint("http://x.example/v1"), (e: unknown) => e instanceof ConfigError);
  assert.throws(() => validateEndpoint("ftp://x.example/v1"), (e: unknown) => e instanceof ConfigError);
  assert.throws(() => validateEndpoint("not a url"), (e: unknown) => e instanceof ConfigError);
});

test("validateEndpoint rejects embedded credentials, query, and fragment", () => {
  assert.throws(() => validateEndpoint("https://user:pass@x.example/v1"), (e: unknown) => e instanceof ConfigError);
  assert.throws(() => validateEndpoint("https://x.example/v1?key=abc"), (e: unknown) => e instanceof ConfigError);
  assert.throws(() => validateEndpoint("https://x.example/v1#frag"), (e: unknown) => e instanceof ConfigError);
});

test("loadConfig rejects maxTokens greater than or equal to contextWindow", async () => {
  const dir = await makeDir();
  try {
    for (const limits of [
      { contextWindow: 100, maxTokens: 100, maxSteps: 1, timeoutMs: 1 },
      { contextWindow: 100, maxTokens: 200, maxSteps: 1, timeoutMs: 1 },
    ]) {
      const path = await writeConfig(dir, { ...VALID, limits }, `c-${Math.random().toString(36).slice(2)}.json`);
      await assert.rejects(loadConfig(path), (e: unknown) => e instanceof ConfigError && e.code === "limits");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects syntactically invalid credential env names", async () => {
  const dir = await makeDir();
  try {
    for (const env of ["", "1BAD", "has-hyphen", "has space", "dot.name"]) {
      const path = await writeConfig(dir, { ...VALID, credential: { env } }, `c-${Math.random().toString(36).slice(2)}.json`);
      await assert.rejects(loadConfig(path), (e: unknown) => e instanceof ConfigError && e.code === "credential");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadLegacyConfig inherits legacy maxSteps and timeoutSeconds when not overridden", async () => {
  const dir = await makeDir();
  try {
    const legacy = {
      baseUrl: "https://legacy.example.invalid/v1",
      model: "legacy-model",
      apiKeyFile: "./key.txt",
      contextTokens: 32768,
      outputTokens: 4096,
      allowedProjects: [],
      maxSteps: 7,
      timeoutSeconds: 90,
    };
    const path = await writeConfig(dir, legacy, "legacy.json");
    const config = await loadLegacyConfig(path);
    assert.equal(config.limits.maxSteps, 7);
    assert.equal(config.limits.timeoutMs, 90_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadLegacyConfig lets overrides beat legacy maxSteps/timeoutSeconds", async () => {
  const dir = await makeDir();
  try {
    const legacy = {
      baseUrl: "https://legacy.example.invalid/v1",
      model: "legacy-model",
      apiKeyFile: "./key.txt",
      contextTokens: 32768,
      outputTokens: 4096,
      allowedProjects: [],
      maxSteps: 7,
      timeoutSeconds: 90,
    };
    const path = await writeConfig(dir, legacy, "legacy.json");
    const config = await loadLegacyConfig(path, { maxSteps: 3, timeoutMs: 1234 });
    assert.equal(config.limits.maxSteps, 3);
    assert.equal(config.limits.timeoutMs, 1234);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadLegacyConfig normalizes override credential and paths through validators", async () => {
  const dir = await makeDir();
  try {
    const legacy = {
      baseUrl: "https://legacy.example.invalid/v1",
      model: "legacy-model",
      contextTokens: 32768,
      outputTokens: 4096,
      allowedProjects: [],
    };
    const path = await writeConfig(dir, legacy, "legacy.json");

    const ok = await loadLegacyConfig(path, {
      credential: { apiKeyFile: "./secrets/key.txt" },
      stateDir: "./rt-state",
      projectHome: "./rt-home",
    });
    assert.equal(ok.credential.apiKeyFile, join(dir, "secrets", "key.txt"));
    assert.equal(ok.paths.stateDir, join(dir, "rt-state"));
    assert.equal(ok.paths.projectHome, join(dir, "rt-home"));

    await assert.rejects(
      loadLegacyConfig(path, { credential: { env: "BAD-NAME" } }),
      (e: unknown) => e instanceof ConfigError && e.code === "credential",
    );
    await assert.rejects(
      loadLegacyConfig(path, { credential: {} }),
      (e: unknown) => e instanceof ConfigError && e.code === "credential",
    );
    await assert.rejects(
      loadLegacyConfig(path, { maxSteps: 0 }),
      (e: unknown) => e instanceof ConfigError,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// keep mkdir imported for future fixture helpers; reference to avoid unused warning
void mkdir;
