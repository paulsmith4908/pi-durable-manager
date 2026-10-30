/**
 * Redaction utilities.
 *
 * Runtime errors, logs, and diagnostics may pass through here before being
 * surfaced. Nothing in this module ever reads a secret file; it only rewrites
 * strings that may already contain secret material.
 */
/** Placeholder emitted in place of any redacted value. */
export const REDACTED = "[REDACTED]";
/**
 * Names of environment variables whose *values* must never be echoed.
 * Matched case-insensitively against a full variable name.
 */
const SECRET_ENV_NAME = /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
/** Header names whose values must never be echoed. */
const SECRET_HEADER = /^(authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)$/i;
/** Common bearer / key token shapes embedded in free text. */
const BEARER_TOKEN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const SK_TOKEN = /\bsk-[A-Za-z0-9._-]{8,}/g;
const DEEPSEEK_TOKEN = /\b(?:ds|dsk)-[A-Za-z0-9._-]{8,}/g;
const MIN_KNOWN_SECRET_LENGTH = 4;
function resolveKnownSecrets(known) {
    if (known === undefined)
        return [];
    const values = typeof known === "function" ? known() : known;
    // Ignore trivially short values: replacing them would corrupt unrelated text.
    return values.filter((v) => typeof v === "string" && v.length >= MIN_KNOWN_SECRET_LENGTH);
}
/**
 * Redact obvious secret tokens from an arbitrary string, plus any exact values
 * supplied via `knownSecrets`. Exact matches are replaced first so a real key
 * is removed even when it matches no heuristic shape.
 *
 * This is a defence-in-depth measure, not a guarantee. Callers must still
 * avoid interpolating raw configs or credentials into messages.
 */
export function redactString(input, knownSecrets) {
    let out = input;
    for (const secret of resolveKnownSecrets(knownSecrets)) {
        out = out.split(secret).join(REDACTED);
    }
    return out
        .replace(BEARER_TOKEN, (_m, scheme) => `${scheme} ${REDACTED}`)
        .replace(SK_TOKEN, REDACTED)
        .replace(DEEPSEEK_TOKEN, REDACTED);
}
/**
 * Redact secret-looking header values in a plain header map. Returns a new
 * object; the input is not mutated. Header names are preserved.
 */
export function redactHeaders(headers) {
    const out = {};
    for (const [name, value] of Object.entries(headers)) {
        if (value == null)
            continue;
        out[name] = SECRET_HEADER.test(name) ? REDACTED : value;
    }
    return out;
}
/**
 * Produce a safe, human-readable summary of an error without embedding raw
 * config objects. Secret tokens in `message`/`stack` are scrubbed.
 */
export function redactError(error, knownSecrets) {
    if (error instanceof Error) {
        return { name: error.name, message: redactString(error.message, knownSecrets) };
    }
    return { name: "Error", message: redactString(String(error), knownSecrets) };
}
/** True when an environment variable name looks like it holds a secret. */
export function isSecretEnvName(name) {
    return SECRET_ENV_NAME.test(name);
}
//# sourceMappingURL=redact.js.map