import { redactString } from "./redact.js";
/** Only emitted text/tool data is recorded. Hidden model reasoning is never a log source. */
export function sanitizeActivity(value, secrets, depth = 0) {
    if (depth > 8)
        return "[depth limited]";
    if (typeof value === "string") {
        const safe = redactString(value, secrets);
        return safe.length > 12000 ? safe.slice(0, 12000) + " [truncated; full evidence retained separately]" : safe;
    }
    if (value === null || typeof value === "number" || typeof value === "boolean")
        return value;
    if (Array.isArray(value))
        return value.slice(0, 32).map(item => sanitizeActivity(item, secrets, depth + 1));
    if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).slice(0, 32).map(([key, item]) => [
            key, /api.?key|authorization|credential|password|secret|access.?token|thinking|reasoningContent/i.test(key)
                ? "[REDACTED]" : sanitizeActivity(item, secrets, depth + 1),
        ]));
    return null;
}
export function formatActivity(entry) {
    // Strip terminal control codes, including OSC links, from untrusted worker text.
    const safe = (value) => value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
    return safe(`[${entry.seq} ${new Date(entry.at).toISOString()}] ${entry.kind}` +
        `${entry.assignmentId ? " " + entry.assignmentId : ""}\n${JSON.stringify(entry.data, null, 2)}\n`);
}
//# sourceMappingURL=activity.js.map