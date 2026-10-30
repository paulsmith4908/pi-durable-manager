// tools/verify-scratch.mjs — real-run diagnostic for integration/src sandbox.ts.
//
// Reproduces the production layout that broke ordinary writes:
//
//   <fixture>/state/             <- protected stateDir (also holds secret.txt)
//   <fixture>/state/scratch/<id> <- the assigned scratch, nested inside state
//   <fixture>/proj/              <- public project root
//
// It builds a policy with protectedPaths=[stateDir] and scratchDir=<state>/scratch/<id>,
// runs a real `runSandboxedCommand` that writes into TMPDIR, HOME, and the project,
// then attempts to read the sibling secret and to write outside the sandbox. Those
// two must fail (no output / no file). Nothing here reads or prints real keys or the
// private service config.
//
// Requires the library to be built (`npm run build`): imports compiled dist/sandbox.js.
//
// Usage:
//   npm run build && node tools/verify-scratch.mjs
//
// Exit code 0 only when every write succeeds AND every escape is blocked. When the
// environment cannot run sandbox-exec at all (nested sandbox), it prints an explicit
// blocked/skip result and exits nonzero — a skip is never reported as a pass.

import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const {
  resolvePolicy,
  buildSandboxProfile,
  runSandboxedCommand,
  canApplyProfile,
  resetSandboxProbe,
} = await import(path.join(HERE, "..", "dist", "sandbox.js"));

const SECRET_MARKER = "SECRET-SHOULD-NEVER-APPEAR";

async function main() {
  const base = mkdtempSync(path.join(tmpdir(), "pi-verify-scratch-"));
  const result = {
    scratchWrite: false,
    homeWrite: false,
    projectWrite: false,
    privateReadBlocked: false,
    outsideWriteBlocked: false,
    ok: false,
  };
  let exitCode = 1;

  try {
    const root = path.join(base, "proj");
    const state = path.join(base, "state");
    const scratch = path.join(state, "scratch", "assignment-1");
    const outside = path.join(base, "outside-write.txt");

    await mkdir(root, { recursive: true });
    await mkdir(scratch, { recursive: true });
    writeFileSync(path.join(root, "main.txt"), "project-initial\n");
    // The sibling private file that must remain unreadable from inside the sandbox.
    writeFileSync(path.join(state, "secret.txt"), SECRET_MARKER + "\n");

    const policy = resolvePolicy({
      root,
      protectedPaths: [state],
      scratchDir: scratch,
    });

    // Structural sanity: the carve-out must be a filter, not a blanket removal.
    // Compare against the policy's CANONICAL scratch, since the profile emits
    // realpath'd paths (e.g. /private/var on macOS).
    const profile = buildSandboxProfile(policy);
    if (
      !profile.includes("(require-all") ||
      !profile.includes(`(require-not (subpath "${policy.scratchDir}"))`)
    ) {
      console.error(JSON.stringify({ ...result, ok: false, error: "profile_missing_carveout" }));
      return 1;
    }

    // Generic launcher probe only: distinguishes "environment cannot run any
    // sandbox" from "the policy profile is broken".
    if (!(await canApplyProfile(policy))) {
      resetSandboxProbe();
      console.error(
        JSON.stringify({
          ...result,
          ok: false,
          skipped: true,
          reason: "sandbox-exec unavailable (nested sandbox); not a pass",
        }),
      );
      return 2;
    }

    // Use the policy's canonical paths for every existence check.
    const cRoot = policy.root;
    const cScratch = policy.scratchDir;
    const cSecret = path.join(policy.protectedPaths[0], "secret.txt");

    const script = [
      `echo scratch > "$TMPDIR/check.txt"`,
      `echo home > "$HOME/check.txt"`,
      `echo changed > "main.txt"`,
      `echo pwned > "${outside}" 2>/dev/null || true`,
      `cat "${cSecret}" 2>/dev/null || true`,
    ].join("\n");

    const run = await runSandboxedCommand(policy, script);

    result.scratchWrite = existsSync(path.join(cScratch, ".tmp", "check.txt"));
    result.homeWrite = existsSync(path.join(cScratch, ".home", "check.txt"));
    // The project write must actually CHANGE content, not merely leave the
    // pre-existing file in place.
    const mainPath = path.join(cRoot, "main.txt");
    result.projectWrite =
      existsSync(mainPath) && readFileSync(mainPath, "utf8").includes("changed");
    result.outsideWriteBlocked = !existsSync(outside);
    result.privateReadBlocked =
      !run.stdout.includes(SECRET_MARKER) && !run.stderr.includes(SECRET_MARKER);

    result.ok =
      run.exitCode === 0 &&
      result.scratchWrite &&
      result.homeWrite &&
      result.projectWrite &&
      result.privateReadBlocked &&
      result.outsideWriteBlocked;

    console.log(JSON.stringify(result));
    exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(
      JSON.stringify({ ...result, ok: false, error: String(error?.message ?? error) }),
    );
    exitCode = 1;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }

  return exitCode;
}

process.exit(await main());
