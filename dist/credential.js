import { readFile } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { redactString } from "./redact.js";
/** Raised when a credential cannot be resolved. Never embeds key material. */
export class CredentialError extends Error {
    code;
    constructor(code, message) {
        super(redactString(message));
        this.name = "CredentialError";
        this.code = code;
    }
}
/**
 * Validate a credential FILE by STAT ONLY — never reading its bytes.
 *
 * Proves what `lstat` can prove: presence (missing is a warning at the caller),
 * regular-file-ness, non-symlink, and private permissions (no group/other
 * read/write, i.e. mode & 0o077 === 0). It deliberately does NOT open the file,
 * so a user who mistakenly pastes a raw key into a path argument cannot have it
 * echoed back by this validation.
 */
export function validateCredentialFileStat(filePath) {
    let info;
    try {
        info = lstatSync(filePath);
    }
    catch {
        return { kind: "missing", path: filePath };
    }
    if (info.isSymbolicLink())
        return { kind: "symlink", path: filePath };
    if (!info.isFile())
        return { kind: "not_file", path: filePath };
    const mode = info.mode & 0o777;
    if ((mode & 0o077) !== 0)
        return { kind: "too_open", path: filePath, mode };
    return { kind: "ok", path: filePath, mode };
}
/**
 * Human-readable, redaction-safe summary of a {@link CredentialFileStatus}.
 * Never includes file contents.
 */
export function describeCredentialFileStatus(status) {
    switch (status.kind) {
        case "missing":
            return `file:${status.path} (not found yet — create it as a private file, mode 0600, before running)`;
        case "symlink":
            return `file:${status.path} is a symlink; refusing to trust a redirected credential file`;
        case "not_file":
            return `file:${status.path} is not a regular file (directory/socket/device)`;
        case "too_open":
            return `file:${status.path} has mode ${status.mode.toString(8).padStart(3, "0")}; require 0600`;
        case "ok":
            return `file:${status.path} (regular file, private mode ${status.mode.toString(8).padStart(3, "0")})`;
    }
}
/**
 * Resolve a credential reference into an in-memory key.
 *
 * Call this ONLY from the trusted runtime (the service process), immediately
 * before it is handed to the Pi provider's auth resolver. Never call this from
 * a worker subprocess or a sandboxed tool.
 */
export async function resolveCredential(ref, options = {}) {
    if (ref.none === true)
        return { apiKey: "pi-durable-no-auth", source: "none" };
    if (ref.apiKeyFile !== undefined) {
        let contents;
        try {
            contents = await readFile(ref.apiKeyFile, "utf8");
        }
        catch {
            throw new CredentialError("read", "Unable to read the configured credential file.");
        }
        const apiKey = contents.trim();
        if (apiKey === "") {
            throw new CredentialError("empty", "The configured credential file was empty.");
        }
        return { apiKey, source: "apiKeyFile" };
    }
    if (ref.env !== undefined) {
        const reader = options.env ?? ((name) => process.env[name]);
        const value = reader(ref.env);
        if (value === undefined || value.trim() === "") {
            throw new CredentialError("missing", "The configured credential environment variable is not set.");
        }
        return { apiKey: value.trim(), source: ref.env };
    }
    throw new CredentialError("config", "Credential reference sets neither apiKeyFile nor env.");
}
/**
 * Convert a resolved credential to a safe representation. The API key is
 * dropped entirely; only the source label survives.
 */
export function redactCredential(credential) {
    return { configured: true, source: credential.source };
}
//# sourceMappingURL=credential.js.map