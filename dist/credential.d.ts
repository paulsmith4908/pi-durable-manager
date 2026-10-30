import type { CredentialRef } from "./config.js";
/**
 * A resolved credential.
 *
 * The raw `apiKey` is held only in memory inside the trusted runtime. It must
 * never be written into a worker subprocess environment, argv, logs, or any
 * serialized message. Use {@link RedactedCredential} for anything crossing a
 * process or log boundary.
 */
export interface ResolvedCredential {
    /** Raw API key. Never serialize or log this field. */
    readonly apiKey: string;
    /** Human-readable description of where the key came from (no key material). */
    readonly source: string;
}
/** A credential representation safe to log or pass to status UIs. */
export interface RedactedCredential {
    readonly configured: true;
    readonly source: string;
}
/** Raised when a credential cannot be resolved. Never embeds key material. */
export declare class CredentialError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/**
 * The result of a STAT-ONLY credential-file validation.
 *
 * `kind` is one of:
 *   - `"missing"`  — the path does not exist yet; a WARNING, not a failure (the
 *                    file may be provisioned privately later).
 *   - `"symlink"`  — the path is a symlink; FAIL (do not trust a redirect).
 *   - `"not_file"` — exists but is a directory/socket/device; FAIL.
 *   - `"too_open"` — a regular file whose mode grants group/other access; FAIL.
 *   - `"ok"`       — a regular, non-symlink, privately-permissioned file.
 *
 * `mode` is the permission bits when known (else undefined). No file BYTES are
 * ever read or returned — this is purely metadata.
 */
export type CredentialFileStatus = {
    readonly kind: "missing";
    readonly path: string;
} | {
    readonly kind: "symlink";
    readonly path: string;
} | {
    readonly kind: "not_file";
    readonly path: string;
} | {
    readonly kind: "too_open";
    readonly path: string;
    readonly mode: number;
} | {
    readonly kind: "ok";
    readonly path: string;
    readonly mode: number;
};
/**
 * Validate a credential FILE by STAT ONLY — never reading its bytes.
 *
 * Proves what `lstat` can prove: presence (missing is a warning at the caller),
 * regular-file-ness, non-symlink, and private permissions (no group/other
 * read/write, i.e. mode & 0o077 === 0). It deliberately does NOT open the file,
 * so a user who mistakenly pastes a raw key into a path argument cannot have it
 * echoed back by this validation.
 */
export declare function validateCredentialFileStat(filePath: string): CredentialFileStatus;
/**
 * Human-readable, redaction-safe summary of a {@link CredentialFileStatus}.
 * Never includes file contents.
 */
export declare function describeCredentialFileStatus(status: CredentialFileStatus): string;
/** Environment lookup abstraction so tests never touch the real process env. */
export type EnvReader = (name: string) => string | undefined;
export interface ResolveCredentialOptions {
    /** Environment accessor. Defaults to `process.env[name]`. */
    env?: EnvReader;
}
/**
 * Resolve a credential reference into an in-memory key.
 *
 * Call this ONLY from the trusted runtime (the service process), immediately
 * before it is handed to the Pi provider's auth resolver. Never call this from
 * a worker subprocess or a sandboxed tool.
 */
export declare function resolveCredential(ref: CredentialRef, options?: ResolveCredentialOptions): Promise<ResolvedCredential>;
/**
 * Convert a resolved credential to a safe representation. The API key is
 * dropped entirely; only the source label survives.
 */
export declare function redactCredential(credential: ResolvedCredential): RedactedCredential;
//# sourceMappingURL=credential.d.ts.map