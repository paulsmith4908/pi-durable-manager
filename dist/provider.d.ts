import { type MutableModels, type Model, type Provider } from "@earendil-works/pi-ai";
import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import type { PiDurableConfig } from "./config.js";
import { type ResolvedCredential } from "./credential.js";
/** The single provider id this package registers. */
export declare const MODAL_PROVIDER_ID = "modal";
/** The only chat API used by the Modal provider. */
export declare const MODAL_API: "openai-completions";
/**
 * DeepSeek-compatible OpenAI completions overrides.
 *
 * These match the pinned Modal `deepseek-ai/DeepSeek-V4.1-Flash` endpoint's
 * expected wire behavior as far as is known statically. They are NOT yet
 * proven against a live endpoint — the M1 provider spike must confirm each
 * one. See docs/COMPATIBILITY.md.
 */
export declare const DEEPSEEK_COMPAT: OpenAICompletionsCompat;
/**
 * Build the fixed model metadata for the pinned endpoint.
 *
 * Limits come from config; no values are invented here. Pricing is set to
 * zero with an explicit note, because token cost reported by pi-ai is NOT the
 * actual Modal GPU cost — that is external to this metadata.
 */
export declare function buildModalModel(config: PiDurableConfig): Model<typeof MODAL_API>;
/**
 * Create the `modal` provider.
 *
 * The provider's `auth.apiKey.resolve` returns the supplied credential. The
 * raw key is captured in a closure and is never placed on the provider object
 * or any serializable field. Exactly one provider (id `modal`) is created; no
 * OpenAI or fallback providers are registered.
 */
export declare function createModalProvider(config: PiDurableConfig, credential: ResolvedCredential): Provider<typeof MODAL_API>;
/**
 * Create a `Models` collection containing ONLY the `modal` provider.
 *
 * Convenience entry point for the next harness worker. No default or fallback
 * providers are registered.
 */
export declare function createModalModels(config: PiDurableConfig, credential: ResolvedCredential): MutableModels;
/** Safe, key-free description of the configured provider for diagnostics. */
export declare function describeProvider(config: PiDurableConfig, credential: ResolvedCredential): {
    providerId: string;
    api: "openai-completions";
    model: string;
    endpoint: string;
    contextWindow: number;
    maxTokens: number;
    compat: OpenAICompletionsCompat | undefined;
    credential: import("./credential.js").RedactedCredential;
};
export declare function configuredProviderId(config: PiDurableConfig): string;
//# sourceMappingURL=provider.d.ts.map