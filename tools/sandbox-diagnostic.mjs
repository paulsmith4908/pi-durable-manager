#!/usr/bin/env node
/**
 * sandbox-diagnostic.mjs — run the ACTUAL production profile on a harmless
 * command and report the raw kernel result (status / signal / stderr).
 *
 * Purpose: distinguish "sandbox-exec cannot apply any profile here" (nested or
 * host-restricted: the generic `(version 1)(allow default)` probe fails) from
 * "the production profile is rejected / over-denies" (generic probe passes, but
 * the built profile aborts). Prints no private paths and no keys — the project
 * root is a fresh temp dir, and stderr is captured verbatim (seatbelt's own
 * diagnostics only).
 *
 * Usage:
 *   npm run build && node tools/sandbox-diagnostic.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSandboxProfile, resolvePolicy } from "../dist/sandbox.js";

const LAUNCHER = "/usr/bin/sandbox-exec";

/** Run launcher with a profile and a harmless command, capturing raw result. */
function run(profile, command) {
  return new Promise((resolvePromise) => {
    const child = spawn(LAUNCHER, ["-p", profile, command], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("close", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
    child.on("error", (error) => resolvePromise({ code: null, signal: null, stdout, stderr: String(error) }));
  });
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "pdm-diag-")));
const policy = resolvePolicy({ root });

console.log("platform:", process.platform);
console.log("launcher:", LAUNCHER);
console.log("root: <temp project dir>");

const generic = await run("(version 1)(allow default)", "/usr/bin/true");
console.log("\n[generic probe] (version 1)(allow default) /usr/bin/true");
console.log("  status:", generic.code, "signal:", generic.signal);
if (generic.stderr) console.log("  stderr:", generic.stderr.trim());

const profile = buildSandboxProfile(policy);
const actual = await run(profile, "/usr/bin/true");
console.log("\n[actual profile] <built policy> /usr/bin/true");
console.log("  status:", actual.code, "signal:", actual.signal);
if (actual.stderr) console.log("  stderr:", actual.stderr.trim());

const inside = join(root, "in.txt");
const writeActual = await run(profile, `/bin/sh -c 'printf ok > "${inside}"'`);
console.log("\n[actual profile] write inside project");
console.log("  status:", writeActual.code, "signal:", writeActual.signal);
if (writeActual.stderr) console.log("  stderr:", writeActual.stderr.trim());

const outside = join(realpathSync(tmpdir()), `pdm-diag-outside-${process.pid}.txt`);
const writeOutside = await run(profile, `/bin/sh -c 'printf nope > "${outside}"'`);
console.log("\n[actual profile] write outside project (must fail)");
console.log("  status:", writeOutside.code, "signal:", writeOutside.signal);
if (writeOutside.stderr) console.log("  stderr:", writeOutside.stderr.trim());

const launcherUnavailable = generic.code !== 0 && /Operation not permitted/.test(generic.stderr);
const ok = generic.code === 0 && actual.code === 0 && writeActual.code === 0 && writeOutside.code !== 0;
console.log("");
if (launcherUnavailable) {
  console.log("verdict: LAUNCHER UNAVAILABLE HERE (nested/host-restricted; re-run from a real root shell)");
  console.log("  The generic (allow default) probe failed with EPERM, so this environment");
  console.log("  cannot run sandbox-exec at all — the policy result above is not meaningful.");
  process.exitCode = 2;
} else {
  console.log("verdict:", ok ? "POLICY OK" : "POLICY PROBLEM (see statuses above)");
  process.exitCode = ok ? 0 : 1;
}
