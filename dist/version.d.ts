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
/** Kept in lock-step with package.json; a unit test asserts equality. */
export declare const FALLBACK_PACKAGE_VERSION = "0.7.0-beta.3";
/** Read the installed package version, falling back truthfully if unavailable. */
export declare function packageVersion(): string;
//# sourceMappingURL=version.d.ts.map