import {
  createModels,
  createProvider,
  type MutableModels,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import type { PiDurableConfig } from "./config.js";
import { redactCredential, type ResolvedCredential } from "./credential.js";

/** The single provider id this package registers. */
export const MODAL_PROVIDER_ID = "modal";

/** The only chat API used by the Modal provider. */
export const MODAL_API = "openai-completions" as const;

/**
 * DeepSeek-compatible OpenAI completions overrides.
 *
 * These match the pinned Modal `deepseek-ai/DeepSeek-V4.1-Flash` endpoint's
 * expected wire behavior as far as is known statically. They are NOT yet
 * proven against a live endpoint — the M1 provider spike must confirm each
 * one. See docs/COMPATIBILITY.md.
 */
export const DEEPSEEK_COMPAT: OpenAICompletionsCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  maxTokensField: "max_tokens",
  requiresReasoningContentOnAssistantMessages: true,
  thinkingFormat: "deepseek",
  supportsStrictMode: false,
};

/**
 * Build the fixed model metadata for the pinned endpoint.
 *
 * Limits come from config; no values are invented here. Pricing is set to
 * zero with an explicit note, because token cost reported by pi-ai is NOT the
 * actual Modal GPU cost — that is external to this metadata.
 */
export function buildModalModel(config: PiDurableConfig): Model<typeof MODAL_API> {
  const compat: OpenAICompletionsCompat = { ...(config.compatibilityPreset === "generic" ? { supportsStore:false, supportsDeveloperRole:false, supportsReasoningEffort:false, supportsUsageInStreaming:false, supportsStrictMode:false, maxTokensField:"max_tokens" as const } : DEEPSEEK_COMPAT), ...(config.compat ?? {}) };

  return {
    id: config.model,
    name: config.model,
    api: MODAL_API,
    provider: configuredProviderId(config),
    baseUrl: config.endpoint,
    reasoning: config.reasoning ?? config.compatibilityPreset !== "generic",
    input: ["text"],
    cost: {
      // Not actual Modal GPU cost. Treated as unknown/zero pending real usage
      // accounting; see docs/COMPATIBILITY.md.
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: config.limits.contextWindow,
    maxTokens: config.limits.maxTokens,
    compat,
  };
}

/**
 * Create the `modal` provider.
 *
 * The provider's `auth.apiKey.resolve` returns the supplied credential. The
 * raw key is captured in a closure and is never placed on the provider object
 * or any serializable field. Exactly one provider (id `modal`) is created; no
 * OpenAI or fallback providers are registered.
 */
export function createModalProvider(
  config: PiDurableConfig,
  credential: ResolvedCredential,
): Provider<typeof MODAL_API> {
  const model = buildModalModel(config);

  return createProvider<typeof MODAL_API>({
    id: configuredProviderId(config),
    name: config.compatibilityPreset === "generic" ? "OpenAI-compatible" : "Modal (preserved)",
    baseUrl: config.endpoint,
    auth: {
      apiKey: {
        name: "Modal API key",
        resolve: async () => ({
          auth: { apiKey: credential.apiKey },
          source: credential.source,
        }),
      },
    },
    models: [model],
    api: openAICompletionsApi(),
  });
}

/**
 * Create a `Models` collection containing ONLY the `modal` provider.
 *
 * Convenience entry point for the next harness worker. No default or fallback
 * providers are registered.
 */
export function createModalModels(
  config: PiDurableConfig,
  credential: ResolvedCredential,
): MutableModels {
  const models = createModels();
  models.setProvider(createModalProvider(config, credential));
  return models;
}

/** Safe, key-free description of the configured provider for diagnostics. */
export function describeProvider(config: PiDurableConfig, credential: ResolvedCredential) {
  return {
    providerId: configuredProviderId(config),
    api: MODAL_API,
    model: config.model,
    endpoint: config.endpoint,
    contextWindow: config.limits.contextWindow,
    maxTokens: config.limits.maxTokens,
    compat: buildModalModel(config).compat,
    credential: redactCredential(credential),
  };
}

export function configuredProviderId(config: PiDurableConfig): string { return config.compatibilityPreset === "generic" ? "openai-compatible" : MODAL_PROVIDER_ID; }
