import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildModalModel,
  createModalModels,
  createModalProvider,
  describeProvider,
  DEEPSEEK_COMPAT,
  MODAL_API,
  MODAL_PROVIDER_ID,
} from "../src/provider.js";
import type { PiDurableConfig } from "../src/config.js";
import type { ResolvedCredential } from "../src/credential.js";

const SUPER_SECRET = "sk-this-is-a-fake-key-not-real-0000";

const CONFIG: PiDurableConfig = {
  configVersion: 1,
  endpoint: "https://inference.example.invalid/v1",
  model: "deepseek-ai/DeepSeek-V4.1-Flash",
  limits: { contextWindow: 65536, maxTokens: 8192, maxSteps: 40, timeoutMs: 1800000 },
  paths: { stateDir: "/tmp/state", projectHome: "/tmp/projects", allowedRoots: ["/tmp/projects"] },
  credential: { env: "PI_DURABLE_API_KEY" },
};

const CRED: ResolvedCredential = { apiKey: SUPER_SECRET, source: "test" };

test("buildModalModel pins provider, api, model id, endpoint and limits", () => {
  const model = buildModalModel(CONFIG);
  assert.equal(model.provider, MODAL_PROVIDER_ID);
  assert.equal(model.provider, "modal");
  assert.equal(model.api, MODAL_API);
  assert.equal(model.api, "openai-completions");
  assert.equal(model.id, CONFIG.model);
  assert.equal(model.baseUrl, CONFIG.endpoint);
  assert.equal(model.contextWindow, CONFIG.limits.contextWindow);
  assert.equal(model.maxTokens, CONFIG.limits.maxTokens);
  // DeepSeek compat is applied and no extra keys are invented.
  assert.deepEqual(model.compat, DEEPSEEK_COMPAT);
});

test("buildModalModel lets config compat override defaults but keeps the rest", () => {
  const cfg: PiDurableConfig = { ...CONFIG, compat: { supportsStore: true } };
  const model = buildModalModel(cfg);
  assert.equal(model.compat?.supportsStore, true);
  assert.equal(model.compat?.thinkingFormat, "deepseek");
  assert.equal(model.compat?.maxTokensField, "max_tokens");
});

test("createModalProvider registers exactly the modal provider and never leaks the key", () => {
  const provider = createModalProvider(CONFIG, CRED);
  assert.equal(provider.id, MODAL_PROVIDER_ID);
  assert.equal(provider.baseUrl, CONFIG.endpoint);

  // The key must not appear anywhere on the serializable provider surface.
  assert.doesNotMatch(JSON.stringify(provider), new RegExp(SUPER_SECRET.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("createModalModels contains ONLY the modal provider (no default fallback)", () => {
  const models = createModalModels(CONFIG, CRED);
  const providers = models.getProviders();
  assert.equal(providers.length, 1);
  assert.equal(providers[0]?.id, MODAL_PROVIDER_ID);

  // The pinned model resolves; an unrelated provider id does not.
  assert.ok(models.getModel(MODAL_PROVIDER_ID, CONFIG.model));
  assert.equal(models.getModel("openai", "gpt-4o"), undefined);
  assert.equal(models.getModels().length, 1);
});

test("describeProvider is key-free", () => {
  const summary = describeProvider(CONFIG, CRED);
  assert.equal(summary.providerId, MODAL_PROVIDER_ID);
  assert.equal(summary.api, MODAL_API);
  assert.equal(summary.model, CONFIG.model);
  assert.equal(summary.endpoint, CONFIG.endpoint);
  assert.equal(summary.contextWindow, CONFIG.limits.contextWindow);
  assert.equal(summary.maxTokens, CONFIG.limits.maxTokens);
  assert.doesNotMatch(JSON.stringify(summary), new RegExp(SUPER_SECRET.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const cred = summary.credential as unknown as Record<string, unknown>;
  assert.equal(cred.configured, true);
  assert.equal(cred.apiKey, undefined);
});
