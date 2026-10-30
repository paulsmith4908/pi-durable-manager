/**
 * Redaction utilities.
 *
 * Runtime errors, logs, and diagnostics may pass through here before being
 * surfaced. Nothing in this module ever reads a secret file; it only rewrites
 * strings that may already contain secret material.
 */
/** Placeholder emitted in place of any redacted value. */
export declare const REDACTED = "[REDACTED]";
/**
 * A source of exact secret values to remove verbatim. The trusted runtime knows
 * the resolved credential and can pass it here so that a key which does not
 * match any heuristic token shape is still stripped from emitted text.
 */
export type KnownSecrets = readonly string[] | (() => readonly string[]);
/**
 * Redact obvious secret tokens from an arbitrary string, plus any exact values
 * supplied via `knownSecrets`. Exact matches are replaced first so a real key
 * is removed even when it matches no heuristic shape.
 *
 * This is a defence-in-depth measure, not a guarantee. Callers must still
 * avoid interpolating raw configs or credentials into messages.
 */
export declare function redactString(input: string, knownSecrets?: KnownSecrets): string;
/**
 * Redact secret-looking header values in a plain header map. Returns a new
 * object; the input is not mutated. Header names are preserved.
 */
export declare function redactHeaders(headers: Record<string, string | null | undefined>): Record<string, string>;
/**
 * Produce a safe, human-readable summary of an error without embedding raw
 * config objects. Secret tokens in `message`/`stack` are scrubbed.
 */
export declare function redactError(error: unknown, knownSecrets?: KnownSecrets): {
    name: string;
    message: string;
};
/** True when an environment variable name looks like it holds a secret. */
export declare function isSecretEnvName(name: string): boolean;
//# sourceMappingURL=redact.d.ts.map