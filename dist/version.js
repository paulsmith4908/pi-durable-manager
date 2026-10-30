/**
 * The installed package version, resolved from the package's own `package.json`.
 *
 * This module exists so the service can report a TRUTHFUL `packageVersion` in
 * `service.status` / `service.version` without importing `setup.ts` (which
 * imports the config/runtime modules — a circular dependency). It reads only
 * the version string; nothing here is secret.
 *
 * Resolution order:
 *   1. `../package.json` relative to this module (works from both `dist/` and
 *      `dist-test/src/` because the package root is a fixed number of levels up
 *      in each shipped layout — we walk up a bounded number of directories).
 *   2. The constant fallback below, used ONLY if the manifest cannot be read
 *      (e.g. a bundler that drops JSON). It is intentionally identical to the
 *      package.json version, and a test asserts they agree.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/** Kept in lock-step with package.json; a unit test asserts equality. */
export const FALLBACK_PACKAGE_VERSION = "0.7.0-beta.2";
let cached;
/** Read the installed package version, falling back truthfully if unavailable. */
export function packageVersion() {
    if (cached !== undefined)
        return cached;
    cached = readPackageVersion() ?? FALLBACK_PACKAGE_VERSION;
    return cached;
}
function readPackageVersion() {
    let dir;
    try {
        dir = dirname(fileURLToPath(import.meta.url));
    }
    catch {
        return undefined;
    }
    // Walk up a bounded number of levels looking for a package.json whose `name`
    // is this package (guards against picking up an unrelated manifest).
    for (let i = 0; i < 6; i += 1) {
        const candidate = join(dir, "package.json");
        if (existsSync(candidate)) {
            try {
                const manifest = JSON.parse(readFileSync(candidate, "utf8"));
                if (manifest.name === "pi-durable-manager" && typeof manifest.version === "string") {
                    return manifest.version;
                }
            }
            catch {
                /* fall through and keep walking */
            }
        }
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return undefined;
}
//# sourceMappingURL=version.js.map