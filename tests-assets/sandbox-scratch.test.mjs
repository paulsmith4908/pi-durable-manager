// Tests for integration/sandbox.ts: the assigned-scratch carve-out, host layout
// preparation, policy validation, and (when a real launcher is usable) live
// sandbox file-write behaviour. No secrets, no global writes, temp dirs only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX = path.join(HERE, "..", "dist", "sandbox.js");

// Load the TypeScript module via Node's type stripping (Node >= 22.19).
const sandbox = await import(SANDBOX);
const {
  buildSandboxProfile,
  buildSandboxEnv,
  prepareScratchLayout,
  sandboxLayoutDirs,
  resolvePolicy,
  runSandboxedCommand,
  canApplyProfile,
  resetSandboxProbe,
  ToolError,
} = sandbox;

function makeTmp() {
  // `mkdtempSync(tmpdir(), ...)` returns a path with the *apparent* temp root
  // (e.g. `/var/folders/...` on macOS), but `resolvePolicy` canonicalizes every
  // path with `realpathSync`, which resolves `/var` -> `/private/var`. Structural
  // tests that compare the built profile against the raw fixture string would
  // then never match on a real macOS host. Canonicalize once here (the directory
  // already exists) so fixtures and policy agree on a single canonical form.
  return realpathSync(mkdtempSync(path.join(tmpdir(), "pi-sandbox-test-")));
}

// A fixture mirroring production: project root is public, the state dir is a
// protected *sibling* ancestor, and the assigned scratch lives under it.
async function makeScratchFixture(base) {
  const root = path.join(base, "proj");
  const state = path.join(base, "state");
  const scratch = path.join(state, "scratch", "assignment-1");
  await mkdir(root, { recursive: true });
  await mkdir(scratch, { recursive: true });
  await writeFile(path.join(root, "main.txt"), "project\n");
  await writeFile(path.join(state, "secret.txt"), "SECRET-SHOULD-STAY-PRIVATE\n");
  return { root, state, scratch };
}

// --- SBPL structure: the carve-out is a filter, not a blanket removal --------

test("profile carves assigned scratch out of a protected ancestor with require-not", async () => {
  const base = makeTmp();
  try {
    const { root, state, scratch } = await makeScratchFixture(base);
    const policy = resolvePolicy({ root, protectedPaths: [state], scratchDir: scratch });
    const profile = buildSandboxProfile(policy);

    // The protected ancestor must be denied as a filter that excludes ONLY the
    // assigned scratch — never as a plain `(subpath state)` deny that would
    // shadow the scratch allow-rule.
    assert.match(profile, /\(require-all/);
    assert.match(profile, new RegExp(`\\(subpath "${escapeRe(state)}"\\)`));
    assert.match(profile, new RegExp(`\\(require-not \\(subpath "${escapeRe(scratch)}"\\)\\)`));

    // The scratch is still explicitly allowed read+write above the filter.
    assert.match(profile, new RegExp(`\\(allow file-write\\* \\(subpath "${escapeRe(scratch)}"\\)\\)`));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("protected ancestor is NOT emitted as a blanket subpath deny when scratch is nested", async () => {
  const base = makeTmp();
  try {
    const { root, state, scratch } = await makeScratchFixture(base);
    const policy = resolvePolicy({ root, protectedPaths: [state], scratchDir: scratch });
    const profile = buildSandboxProfile(policy);
    // A whole-ancestor blanket deny would be exactly this line; it must not exist.
    const blanket = `(deny file-read* file-write* (subpath "${state}"))`;
    assert.ok(
      !profile.includes(blanket),
      `blanket protected deny must be replaced by the scratch-aware filter:\n${profile}`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("scratch that is NOT under a protected ancestor keeps a plain deny (no leak)", async () => {
  const base = makeTmp();
  try {
    const root = path.join(base, "proj");
    const scratch = path.join(base, "scratch");
    const other = path.join(base, "other-state");
    await mkdir(root, { recursive: true });
    await mkdir(scratch, { recursive: true });
    await mkdir(other, { recursive: true });
    const policy = resolvePolicy({ root, protectedPaths: [other], scratchDir: scratch });
    const profile = buildSandboxProfile(policy);
    // Unrelated protected tree: plain deny, and no spurious require-not for it.
    assert.ok(profile.includes(`(deny file-read* file-write* (subpath "${other}"))`));
    assert.ok(!profile.includes(`(require-not (subpath "${other}"))`));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("scratch nested under the real home config gets carve-outs on both home and config denies", async () => {
  // Simulated in a child process so HOME can be pointed at a temp dir without
  // mutating this process. Uses the module directly; no sandbox launcher needed.
  const { spawnSync } = await import("node:child_process");
  const base = makeTmp();
  try {
    const root = path.join(base, "proj");
    await mkdir(root, { recursive: true });
    const script = `
      import { buildSandboxProfile, resolvePolicy } from ${JSON.stringify(SANDBOX)};
      const home = process.env.HOME;
      const scratch = home + "/.config/pi/scratch/a1";
      const p = buildSandboxProfile(resolvePolicy({ root: ${JSON.stringify(root)}, scratchDir: scratch }));
      const nots = [...p.matchAll(/\\(require-not \\(subpath "([^"]+)"\\)\\)/g)].map((m) => m[1]);
      console.log(JSON.stringify(nots));
    `;
    const res = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script],
      { encoding: "utf8", env: { ...process.env, HOME: path.join(base, "fakehome") } },
    );
    assert.equal(res.status, 0, res.stderr);
    const nots = JSON.parse(res.stdout.trim());
    const fakeScratch = path.join(base, "fakehome", ".config", "pi", "scratch", "a1");
    // Both the home read-deny and the ~/.config deny must carve out the scratch.
    assert.equal(
      nots.filter((p) => p === fakeScratch).length,
      2,
      `expected home + .config carve-outs, got ${JSON.stringify(nots)}`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("preexisting sibling secret stays blocked while the assigned scratch subtree is the only carve-out", async () => {
  const base = makeTmp();
  try {
    const { root, state, scratch } = await makeScratchFixture(base);
    const secret = path.join(state, "secret.txt");
    const policy = resolvePolicy({ root, protectedPaths: [state], scratchDir: scratch });
    const profile = buildSandboxProfile(policy);

    // The filter excludes ONLY the assigned scratch, never the sibling secret.
    // The same carve-out is emitted by both the file policy and the network
    // control-deny policy (production scratch is nested inside the protected
    // state dir), so de-duplicate before comparing.
    const requireNot = [
      ...new Set(
        [...profile.matchAll(/\(require-not \(subpath "([^"]+)"\)\)/g)].map((m) => m[1]),
      ),
    ];
    assert.deepEqual(
      requireNot.filter((p) => p.startsWith(state)),
      [scratch],
      "the only carve-out under the protected ancestor must be the assigned scratch",
    );
    assert.ok(
      !requireNot.some((p) => state.startsWith(p) && p !== scratch),
      "no broader ancestor may be carved out",
    );

    // The secret is inside the denied ancestor and outside the carve-out, so the
    // filter rule denies it. No allow rule may ever name the secret.
    assert.ok(
      profile.includes(`(subpath "${state}")`),
      "protected ancestor must still be denied (as a filter)",
    );
    assert.ok(
      !profile.includes(`(allow file-read* (subpath "${secret}")`),
      "the secret must never be re-allowed",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("scratch equal to the protected ancestor is refused at policy build time", async () => {
  const base = makeTmp();
  try {
    const root = path.join(base, "proj");
    const state = path.join(base, "state");
    await mkdir(root, { recursive: true });
    await mkdir(state, { recursive: true });
    // scratch === protected path: an ambiguity that would lift protection.
    assert.throws(
      () => resolvePolicy({ root, protectedPaths: [state], scratchDir: state }),
      (err) => err instanceof ToolError && err.code === "invalid_argument",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("scratch equal to the project root is refused", async () => {
  const base = makeTmp();
  try {
    const root = path.join(base, "proj");
    await mkdir(root, { recursive: true });
    assert.throws(
      () => resolvePolicy({ root, scratchDir: root }),
      (err) => err instanceof ToolError && err.code === "invalid_argument",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- Network policy structure -------------------------------------------------
//
// The bug being fixed: the profile emitted control-socket denials FIRST and then
// a blanket `(allow network-inbound)/(allow network-outbound)` for the dev case.
// SBPL is last-match-wins, so the blanket allow overrode the denials. These
// structural assertions pin the corrected deny-by-default shape; the live test
// below proves it against the kernel.

test("network is deny-by-default in every profile (no blanket allow)", async () => {
  const base = makeTmp();
  try {
    const { root, state, scratch } = await makeScratchFixture(base);
    for (const allowNetwork of [false, true]) {
      const policy = resolvePolicy({
        root,
        protectedPaths: [state],
        scratchDir: scratch,
        allowNetwork,
      });
      const profile = buildSandboxProfile(policy);
      assert.match(profile, /^\(deny network\*\)$/m, "base `(deny network*)` is required");
      // No rule may grant a *bare* (filterless) network allow — every allow must
      // carry a filter: `(remote ...)`/`(local ...)` for ip/tcp/udp, or a bare
      // path filter `(subpath ...)`/`(literal ...)` for unix sockets.
      assert.doesNotMatch(profile, /\(allow network-outbound\)/);
      assert.doesNotMatch(profile, /\(allow network-inbound\)/);
      assert.doesNotMatch(profile, /\(allow network-bind\)/);
      assert.doesNotMatch(profile, /\(allow network\*\)/);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("allowNetwork:true allows outbound IP (npm HTTPS) and loopback bind/inbound", async () => {
  const base = makeTmp();
  try {
    const { root, state, scratch } = await makeScratchFixture(base);
    const policy = resolvePolicy({
      root,
      protectedPaths: [state],
      scratchDir: scratch,
      allowNetwork: true,
    });
    const profile = buildSandboxProfile(policy);
    // npm needs external HTTPS: outbound IP must be all-hosts/all-ports. SBPL
    // requires a port, so the valid form is "*:*".
    assert.match(profile, /\(allow network-outbound \(remote ip "\*:\*"\)\)/);
    // A dev server the child starts needs to bind + accept on loopback only.
    assert.match(profile, /\(allow network-bind \(local ip "localhost:\*"\)\)/);
    assert.match(profile, /\(allow network-inbound \(local ip "localhost:\*"\)\)/);
    // No routable interface is opened for listening.
    assert.doesNotMatch(profile, /\(allow network-(?:bind|inbound) \(local ip "\*:\*"\)\)/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("allowNetwork:true scopes unix sockets to project/scratch for outbound, bind and inbound", async () => {
  const base = makeTmp();
  try {
    const { root, state, scratch } = await makeScratchFixture(base);
    const policy = resolvePolicy({
      root,
      protectedPaths: [state],
      scratchDir: scratch,
      allowNetwork: true,
    });
    const profile = buildSandboxProfile(policy);
    // SBPL expresses a unix-socket path scope as a bare path filter attached
    // directly to the operation, e.g. `(allow network-bind (subpath "/x"))` —
    // the form the shipping macOS profiles use (application.sb, rpcbind.sb).
    // The old nested `(local|remote unix-socket ...)` wrapper compiled but never
    // matched a real connect/bind, so the project's own socket was denied.
    for (const op of ["outbound", "bind", "inbound"]) {
      assert.match(
        profile,
        new RegExp(`\\(allow network-${op} \\(subpath "${escapeRe(root)}"\\)\\)`),
        `network-${op} must be scoped to the project tree`,
      );
      assert.match(
        profile,
        new RegExp(`\\(allow network-${op} \\(subpath "${escapeRe(scratch)}"\\)\\)`),
        `network-${op} must be scoped to the scratch tree`,
      );
    }
    // The old nested wrapper form must be gone entirely.
    assert.doesNotMatch(profile, /unix-socket/);
    // The protected control tree is never re-allowed for any operation.
    for (const op of ["outbound", "bind", "inbound"]) {
      assert.doesNotMatch(
        profile,
        new RegExp(`\\(allow network-${op} \\(subpath "${escapeRe(state)}"\\)\\)`),
      );
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("allowNetwork:false grants no network allow at all", async () => {
  const base = makeTmp();
  try {
    const { root, state, scratch } = await makeScratchFixture(base);
    const policy = resolvePolicy({
      root,
      protectedPaths: [state],
      scratchDir: scratch,
      allowNetwork: false,
    });
    const profile = buildSandboxProfile(policy);
    assert.doesNotMatch(profile, /\(allow network/);
    assert.match(profile, /^\(deny network\*\)$/m);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("control unix-socket denials are re-stated and never lifted by allowNetwork", async () => {
  const base = makeTmp();
  try {
    const { root, state, scratch } = await makeScratchFixture(base);
    const policy = resolvePolicy({
      root,
      protectedPaths: [state],
      scratchDir: scratch,
      allowNetwork: true,
    });
    const profile = buildSandboxProfile(policy);
    // /private/var/run is always denied (both /var and /private/var aliases).
    assert.match(profile, /\(deny network\* \(literal "\/private\/var\/run"\)\)/);
    for (const dir of [state]) {
      // The assigned scratch is nested *inside* this protected state dir
      // (`<state>/scratch/<id>`), so the subpath deny is emitted as a
      // scratch-aware filter — identical in shape to the file policy's
      // `require-not` carve-out — rather than a blanket subpath deny that would
      // also re-block the scratch unix socket allowed above. The protected dir's
      // own literal deny is unchanged, and its siblings stay denied.
      assert.match(
        profile,
        new RegExp(
          `\\(deny network\\*\\n  \\(require-all\\n    \\(subpath "${escapeRe(dir)}"\\)\\n` +
            `    \\(require-not \\(subpath "${escapeRe(scratch)}"\\)\\)\\)\\)`,
        ),
      );
      assert.match(
        profile,
        new RegExp(`\\(deny network\\* \\(literal "${escapeRe(dir)}"\\)\\)`),
      );
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- OS DNS resolution socket ------------------------------------------------
//
// With `(deny network*)` in force, a sandboxed child cannot reach the OS
// resolver's Unix socket, so name lookups fail with `getaddrinfo ENOTFOUND`
// even though outbound IP is allowed. Apple's shipping profile
// com.apple.security.XPCTimeStampingService.sb (line 79) expresses exactly this
// grant as `(allow network-outbound (literal "/private/var/run/mDNSResponder"))`.
// The profile mirrors that ONE known socket — canonical + `/var` alias — ONLY
// under allowNetwork:true, and nothing broader.

test("allowNetwork:true grants ONLY the exact OS DNS socket (mDNSResponder), literal-only", async () => {
  const base = makeTmp();
  try {
    const { root, state, scratch } = await makeScratchFixture(base);
    const policy = resolvePolicy({
      root,
      protectedPaths: [state],
      scratchDir: scratch,
      allowNetwork: true,
    });
    const profile = buildSandboxProfile(policy);

    // Exact literal allow for the canonical and `/var` alias forms.
    assert.match(
      profile,
      /\(allow network-outbound \(literal "\/private\/var\/run\/mDNSResponder"\)\)/,
    );
    assert.match(
      profile,
      /\(allow network-outbound \(literal "\/var\/run\/mDNSResponder"\)\)/,
    );
    // It must be OUTBOUND only — bind/inbound on the OS socket are never needed.
    assert.doesNotMatch(profile, /\(allow network-(?:bind|inbound) \(literal "[^"]*mDNSResponder"\)\)/);
    // No broadening to the whole run dir or to unix-socket subpaths.
    assert.doesNotMatch(profile, /\(allow network-outbound \(subpath "\/var\/run"\)\)/);
    assert.doesNotMatch(profile, /\(allow network-outbound \(subpath "\/private\/var\/run"\)\)/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("allowNetwork:false grants NO OS DNS socket allow (default stays offline)", async () => {
  const base = makeTmp();
  try {
    const { root, state, scratch } = await makeScratchFixture(base);
    const policy = resolvePolicy({
      root,
      protectedPaths: [state],
      scratchDir: scratch,
      allowNetwork: false,
    });
    const profile = buildSandboxProfile(policy);
    assert.doesNotMatch(profile, /mDNSResponder/);
    assert.match(profile, /^\(deny network\*\)$/m);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("OS DNS socket allow is ordered after the /var/run denies but before protected-path denies", async () => {
  const base = makeTmp();
  try {
    const { root, state, scratch } = await makeScratchFixture(base);
    const profile = buildSandboxProfile(
      resolvePolicy({
        root,
        // Explicitly protect the DNS socket path itself: its deny must come
        // AFTER the allow so last-match-wins keeps it blocked.
        protectedPaths: [state, "/private/var/run/mDNSResponder"],
        scratchDir: scratch,
        allowNetwork: true,
      }),
    );
    const dnsAllow = profile.indexOf(
      '(allow network-outbound (literal "/private/var/run/mDNSResponder"))',
    );
    const varRunDeny = profile.indexOf('(deny network* (literal "/var/run"))');
    const explicitDeny = profile.indexOf(
      '(deny network* (literal "/private/var/run/mDNSResponder"))',
    );
    assert.ok(varRunDeny !== -1 && dnsAllow !== -1, "expected var-run deny and dns allow");
    assert.ok(dnsAllow > varRunDeny, "dns allow must follow the /var/run literal denies");
    assert.ok(
      explicitDeny !== -1 && explicitDeny > dnsAllow,
      "an explicitly-protected DNS path must be denied AFTER the allow (stays blocked)",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- Ancestor metadata allowances --------------------------------------------
//
// Node's module loader / `node --test` call `fs.realpathSync`+`lstat` on every
// directory from `/` down to the project. When the project (or scratch) lives
// under the real home — which the profile denies read — that walk hit EPERM.
// The profile now emits one `file-read-metadata` literal allow for each *exact*
// ancestor directory, ordered AFTER the home/protected denials. These tests pin
// that shape: literal-only (never subpath), and no content/list re-opening.

test("profile re-allows file-read-metadata for exact ancestor dirs, literal-only", async () => {
  const base = makeTmp();
  try {
    const { root, state, scratch } = await makeScratchFixture(base);
    const policy = resolvePolicy({ root, protectedPaths: [state], scratchDir: scratch });
    const profile = buildSandboxProfile(policy);

    const metaLiterals = [
      ...profile.matchAll(/\(allow file-read-metadata \(literal "([^"]+)"\)\)/g),
    ].map((m) => m[1]);

    // The immediate parent of the project root must be present (this is the
    // directory Node stats just before entering the project).
    assert.ok(
      metaLiterals.includes(path.dirname(root)),
      `expected ancestor ${path.dirname(root)} in ${JSON.stringify(metaLiterals)}`,
    );
    // `/` is always in the ancestor chain; the loader stats it.
    assert.ok(metaLiterals.includes("/"), "root `/` ancestor metadata must be allowed");

    // Never a subpath: that would re-open directory contents / listing.
    assert.doesNotMatch(profile, /\(allow file-read-metadata \(subpath /);

    // The project and scratch themselves must NOT be emitted as bare literals
    // here (they are already read-allowed); only their ancestors are.
    assert.ok(!metaLiterals.includes(root), "project root itself must not be a metadata literal");
    assert.ok(!metaLiterals.includes(scratch), "scratch itself must not be a metadata literal");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("ancestor metadata allows are emitted after the home/protected denials (last-match-wins)", async () => {
  const base = makeTmp();
  try {
    const { root, state, scratch } = await makeScratchFixture(base);
    const policy = resolvePolicy({ root, protectedPaths: [state], scratchDir: scratch });
    const profile = buildSandboxProfile(policy);

    // The home read-deny is emitted for the real user home (the profile reads
    // `process.env.HOME`, which POSIX `os.homedir()` also reflects). Derive the
    // *actual* canonical home rather than assuming a trailing `/home`: on macOS
    // the real path is e.g. `/Users/<user>`, and the sandboxed HOME may itself
    // be a dotted `.home` dir, so a hard-coded `/home` suffix never matches and
    // the assertion would spuriously fail.
    const realHome = realpathSync(homedir());
    const escapedHome = realHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const homeDenyIdx = profile.search(
      new RegExp(`\\(deny file-read\\* \\(subpath "${escapedHome}"\\)\\)`),
    );
    const firstMetaIdx = profile.indexOf("(allow file-read-metadata (literal ");
    assert.ok(homeDenyIdx >= 0, "home read-deny must be present");
    assert.ok(firstMetaIdx >= 0, "ancestor metadata allow must be present");
    assert.ok(
      firstMetaIdx > homeDenyIdx,
      "metadata allows must come AFTER the home deny so they win under last-match-wins",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});


test("prepareScratchLayout creates .home/.tmp/.cache at 0700 and env points at them", async () => {
  const base = makeTmp();
  try {
    const { root, state, scratch } = await makeScratchFixture(base);
    const policy = resolvePolicy({ root, protectedPaths: [state], scratchDir: scratch });
    await prepareScratchLayout(policy);

    for (const dir of sandboxLayoutDirs(policy)) {
      assert.ok(existsSync(dir), `expected prepared dir: ${dir}`);
      assert.equal(statSync(dir).mode & 0o777, 0o700, `expected 0700 on ${dir}`);
    }

    const env = buildSandboxEnv(policy);
    assert.equal(env.HOME, path.join(scratch, ".home"));
    assert.equal(env.TMPDIR, path.join(scratch, ".tmp"));
    assert.equal(env.XDG_CACHE_HOME, path.join(scratch, ".cache"));
    assert.equal(env.XDG_CONFIG_HOME, path.join(scratch, ".home", ".config"));
    assert.equal(env.PWD, root);
    // No credential-style variables are inherited.
    for (const key of ["AWS_SECRET_ACCESS_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
      assert.ok(!(key in env), `env must not carry ${key}`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- Live sandbox behaviour (only when a real launcher is usable) ------------
//
// The worker/CI environment may itself be sandboxed, in which case the *generic*
// launcher probe fails and no profile can be applied. In that case we skip; we
// never skip a genuine policy failure (the policy profile is probed separately,
// and a nested/blocked launcher is exactly the generic-probe case).

test("live: scratch/TMPDIR/HOME/project writes succeed; sibling secret read and outside write are blocked", async (t) => {
  const base = makeTmp();
  try {
    const { root, state, scratch } = await makeScratchFixture(base);
    const policy = resolvePolicy({ root, protectedPaths: [state], scratchDir: scratch });

    // Generic launcher probe only: skip when the *environment* cannot run any
    // sandbox (nested sandbox), never when the real policy profile is at fault.
    const launcherUsable = await canApplyProfile(policy);
    if (!launcherUsable) {
      resetSandboxProbe();
      t.skip("sandbox-exec cannot apply any profile here (nested sandbox)");
      return;
    }

    const outside = path.join(base, "outside-write.txt");
    const privateRead = path.join(state, "secret.txt");

    const script = [
      `echo scratch > "$TMPDIR/check.txt"`,
      `echo home > "$HOME/check.txt"`,
      `echo project > "main.txt"`,
      `cat "${privateRead}" 2>/dev/null || true`,
      `echo pwned > "${outside}" 2>/dev/null || true`,
      `echo "PRIVATE_READ=$(cat "${privateRead}" 2>/dev/null | tr -d '\\n')"`,
    ].join("\n");

    const result = await runSandboxedCommand(policy, script);
    assert.equal(result.exitCode, 0, `command should complete: ${result.stderr}`);

    // Writes the host prepared succeed.
    assert.ok(existsSync(path.join(scratch, ".tmp", "check.txt")), "TMPDIR write");
    assert.ok(existsSync(path.join(scratch, ".home", "check.txt")), "HOME write");
    assert.ok(existsSync(path.join(root, "main.txt")), "project write");
    assert.match(readFileSync(path.join(root, "main.txt"), "utf8"), /project/);

    // The protected sibling secret stays unreadable and unexposed.
    assert.ok(!existsSync(outside), "outside write must be blocked");
    assert.doesNotMatch(result.stdout, /SECRET-SHOULD-STAY-PRIVATE/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- Live network confinement (only when a real launcher is usable) ----------
//
// This is the kernel-gated regression test for the network-policy bug: with
// allowNetwork:true a child must reach its own project unix socket and a
// loopback TCP dev server, but MUST NOT reach a control unix socket that lives
// outside the project/scratch — including via a canonical alias. Skipped in a
// nested sandbox (where no profile can be applied at all).

test("live: allowNetwork permits project/loopback but blocks outside control unix socket", async (t) => {
  const { createServer } = await import("node:net");
  const base = makeTmp();
  try {
    const { root, state, scratch } = await makeScratchFixture(base);

    // Reuse the fixture, but give the "control" server its own sibling tree so
    // it is unambiguously OUTSIDE the project and scratch.
    const controlDir = path.join(base, "control");
    await mkdir(controlDir, { recursive: true });
    const controlSock = path.join(controlDir, "control.sock");
    const controlAliasSock = controlSock.replace(/^\/var\//, "/private/var/");
    const projectSock = path.join(root, "dev.sock");

    // darwin sun_path is 104 bytes incl. NUL; skip (never pass) when the temp
    // fixture path is too long for a unix socket to be bound at all.
    if (Math.max(controlSock.length, projectSock.length) > 100) {
      t.skip("temp path too long for a unix socket fixture on this OS");
      return;
    }

    const serverAt = (p) =>
      new Promise((resolve, reject) => {
        const sockets = [];
        const server = createServer((s) => {
          sockets.push(s);
          s.on("error", () => undefined);
          s.end();
        });
        server.on("error", reject);
        server.listen(p, () => resolve({ server, sockets }));
      });

    const control = await serverAt(controlSock);
    const project = await serverAt(projectSock);

    const policy = resolvePolicy({
      root,
      protectedPaths: [state],
      scratchDir: scratch,
      allowNetwork: true,
      timeoutMs: 15000,
    });

    const launcherUsable = await canApplyProfile(policy);
    if (!launcherUsable) {
      resetSandboxProbe();
      await new Promise((r) => control.server.close(r));
      await new Promise((r) => project.server.close(r));
      t.skip("sandbox-exec cannot apply any profile here (nested sandbox)");
      return;
    }

    // The probe child is a plain connection test; it sends no protocol bytes.
    // `probe` takes a net.connect *options object* (not a factory, and not an
    // already-connected Socket): passing a live Socket to a second net.connect
    // is not a valid overload and made every probe report NO.
    const childScript = [
      "import net from 'node:net';",
      "function probe(options) {",
      "  return new Promise((resolve) => {",
      "    let done = false;",
      "    let socket;",
      "    const finish = (ok) => { if (done) return; done = true; clearTimeout(timer);",
      "      try { socket.destroy(); } catch {} resolve(ok); };",
      "    const timer = setTimeout(() => finish(false), 4000);",
      "    try { socket = net.connect(options); } catch { finish(false); return; }",
      "    socket.on('connect', () => finish(true));",
      "    socket.on('error', () => finish(false));",
      "  });",
      "}",
      `console.log('PROJECT', await probe({ path: ${JSON.stringify(projectSock)} }) ? 'OK' : 'NO');`,
      `console.log('CONTROL', await probe({ path: ${JSON.stringify(controlSock)} }) ? 'OK' : 'NO');`,
      `console.log('ALIAS', await probe({ path: ${JSON.stringify(controlAliasSock)} }) ? 'OK' : 'NO');`,
    ].join("\n");

    const result = await runSandboxedCommand(
      policy,
      `/usr/bin/env node --input-type=module -e '${childScript.replace(/'/g, `'\\''`)}'`,
    );

    await new Promise((r) => control.server.close(r));
    await new Promise((r) => project.server.close(r));

    assert.match(result.stdout, /PROJECT OK/, `own project socket must be reachable:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /CONTROL NO/, `outside control socket must be blocked:\n${result.stdout}`);
    assert.match(result.stdout, /ALIAS NO/, `canonical control alias must be blocked:\n${result.stdout}`);
    assert.equal(control.sockets.length, 0, "control server must never accept a connection");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// Production-layout diagnostic: scratch lives INSIDE the protected state dir
// (`<state>/scratch/<id>`), so the network control-deny block for that state dir
// must carve the scratch back out — otherwise its last-match-wins subpath deny
// re-blocks every scratch unix socket. Here the "control" socket lives in a
// synthetic sibling parent (no real manager protocol, no real manager process):
// it stands in for a service socket that must stay unreachable. This proves the
// actual state/scratch layout: the child reaches its OWN scratch socket while the
// synthetic control stays blocked via both the raw path and the canonical alias.

test("live: production layout — own scratch unix socket allowed, synthetic control stays blocked", async (t) => {
  const { createServer } = await import("node:net");
  // Short base so the unix-socket sun_path stays under the ~104-byte limit: on
  // macOS the apparent temp root is `/var/folders/...` but realpath is
  // `/private/var/folders/...`, which is longer, so keep the leaf names tight.
  const base = shortBaseDir();
  try {
    // Mirrors production exactly: public project root, protected state dir, and
    // the assigned scratch nested *under* that protected state dir.
    const root = path.join(base, "p");
    const state = path.join(base, "s");
    const scratch = path.join(state, "scratch", "a1");
    await mkdir(root, { recursive: true });
    await mkdir(scratch, { recursive: true });
    await mkdir(path.join(state, "secret"), { recursive: true });
    await writeFile(path.join(root, "main.txt"), "project\n");

    const policy = resolvePolicy({
      root,
      protectedPaths: [state],
      scratchDir: scratch,
      allowNetwork: true,
      timeoutMs: 15000,
    });
    const profile = buildSandboxProfile(policy);

    // Structural proof of the carve-out: the protected state dir's network
    // subpath deny is a scratch-aware filter, so the nested scratch is excluded
    // (matching the file policy), while the protected dir's own literal deny
    // remains so its siblings/aliases stay blocked.
    assert.match(
      profile,
      new RegExp(
        `\\(deny network\\*\\n  \\(require-all\\n    \\(subpath "${escapeRe(state)}"\\)\\n` +
          `    \\(require-not \\(subpath "${escapeRe(scratch)}"\\)\\)\\)\\)`,
      ),
      "protected state network deny must carve out only the assigned scratch",
    );
    assert.match(
      profile,
      new RegExp(`\\(deny network\\* \\(literal "${escapeRe(state)}"\\)\\)`),
      "protected state literal deny must remain",
    );
    assert.match(
      profile,
      new RegExp(`\\(allow network-outbound \\(subpath "${escapeRe(scratch)}"\\)\\)`),
      "own scratch unix socket must be allowed outbound",
    );

    // Synthetic control parent (a sibling of root/state, OUTSIDE project+scratch)
    // — no real manager protocol or process is contacted.
    const controlDir = path.join(base, "c");
    await mkdir(controlDir, { recursive: true });
    const controlSock = path.join(controlDir, "c.sock");
    const controlAliasSock = controlSock.replace(/^\/var\//, "/private/var/");
    const scratchSock = path.join(scratch, "own.sock");

    if (Math.max(scratchSock.length, controlSock.length, controlAliasSock.length) > 100) {
      t.skip("temp path too long for a unix socket fixture on this OS");
      return;
    }

    const serverAt = (p) =>
      new Promise((resolve, reject) => {
        const sockets = [];
        const server = createServer((s) => {
          sockets.push(s);
          s.on("error", () => undefined);
          s.end();
        });
        server.on("error", reject);
        server.listen(p, () => resolve({ server, sockets }));
      });

    const scratchSrv = await serverAt(scratchSock);
    const control = await serverAt(controlSock);

    const launcherUsable = await canApplyProfile(policy);
    if (!launcherUsable) {
      resetSandboxProbe();
      await new Promise((r) => scratchSrv.server.close(r));
      await new Promise((r) => control.server.close(r));
      t.skip("sandbox-exec cannot apply any profile here (nested sandbox)");
      return;
    }

    const childScript = [
      "import net from 'node:net';",
      "function probe(options) {",
      "  return new Promise((resolve) => {",
      "    let done = false; let socket;",
      "    const finish = (ok) => { if (done) return; done = true; clearTimeout(timer);",
      "      try { socket.destroy(); } catch {} resolve(ok); };",
      "    const timer = setTimeout(() => finish(false), 4000);",
      "    try { socket = net.connect(options); } catch { finish(false); return; }",
      "    socket.on('connect', () => finish(true));",
      "    socket.on('error', () => finish(false));",
      "  });",
      "}",
      `console.log('SCRATCH', await probe({ path: ${JSON.stringify(scratchSock)} }) ? 'OK' : 'NO');`,
      `console.log('CONTROL', await probe({ path: ${JSON.stringify(controlSock)} }) ? 'OK' : 'NO');`,
      `console.log('ALIAS', await probe({ path: ${JSON.stringify(controlAliasSock)} }) ? 'OK' : 'NO');`,
    ].join("\n");

    const result = await runSandboxedCommand(
      policy,
      `/usr/bin/env node --input-type=module -e '${childScript.replace(/'/g, `'\\''`)}'`,
    );

    await new Promise((r) => scratchSrv.server.close(r));
    await new Promise((r) => control.server.close(r));

    assert.match(
      result.stdout,
      /SCRATCH OK/,
      `own scratch unix socket must be reachable:\n${result.stdout}\n${result.stderr}`,
    );
    assert.match(result.stdout, /CONTROL NO/, `synthetic control must stay blocked:\n${result.stdout}`);
    assert.match(result.stdout, /ALIAS NO/, `control alias must stay blocked:\n${result.stdout}`);
    assert.ok(scratchSrv.sockets.length >= 1, "own scratch server must accept the connection");
    assert.equal(control.sockets.length, 0, "control server must never accept a connection");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- Live ancestor-metadata walk --------------------------------------------
//
// Regression for the real failure: a project nested in the (denied) real home
// makes `fs.realpathSync`/`lstat` of an ancestor dir fail with EPERM, before a
// single test runs. The child stats every ancestor of the project (metadata must
// be allowed), while listing the *contents* of the protected scratch-parent —
// the denied ancestor that holds both the secret and the scratch carve-out —
// must stay blocked.
//
// Note on scoping: the ancestor-listing assertion targets the protected state
// tree (`<base>/state`), NOT the raw fixture base (`os.tmpdir()` on the host).
// The fixture base is only denied when the project happens to live under the
// real (home) deny; in CI the temp dir is frequently not under home, so listing
// it is legitimately allowed and asserting a deny there would be host-dependent.
// The protected state tree is denied by construction (only the assigned scratch
// is carved out), so this assertion holds on every host.

test("live: child can stat/lstat every ancestor dir but cannot list the protected scratch-parent", async (t) => {
  const base = makeTmp();
  try {
    const { root, state, scratch } = await makeScratchFixture(base);
    const policy = resolvePolicy({
      root,
      protectedPaths: [state],
      scratchDir: scratch,
      timeoutMs: 15000,
    });

    const launcherUsable = await canApplyProfile(policy);
    if (!launcherUsable) {
      resetSandboxProbe();
      t.skip("sandbox-exec cannot apply any profile here (nested sandbox)");
      return;
    }

    const childScript = [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      `const root = ${JSON.stringify(root)};`,
      "let dir = root;",
      "const chain = [];",
      "while (true) { chain.push(dir); const p = path.dirname(dir); if (p === dir) break; dir = p; }",
      "let statOk = 0;",
      "for (const d of chain) {",
      "  try { fs.lstatSync(d); fs.statSync(d); statOk++; }",
      "  catch (e) { console.log('STAT_FAIL', d, e.code); }",
      "}",
      "console.log('STAT_OK', statOk, chain.length);",
      `try {`,
      `  const entries = fs.readdirSync(${JSON.stringify(state)});`,
      `  console.log('LIST_PROTECTED OK', entries.length);`,
      `} catch (e) { console.log('LIST_PROTECTED BLOCKED', e.code); }`,
      `try {`,
      `  fs.readFileSync(${JSON.stringify(path.join(state, "secret.txt"))});`,
      `  console.log('READ_SECRET OK');`,
      `} catch (e) { console.log('READ_SECRET BLOCKED', e.code); }`,
    ].join("\n");

    const result = await runSandboxedCommand(
      policy,
      `/usr/bin/env node --input-type=module -e '${childScript.replace(/'/g, `'\\''`)}'`,
    );

    assert.match(
      result.stdout,
      /STAT_OK (\d+) (\d+)/,
      `ancestor stat walk must run:\n${result.stdout}\n${result.stderr}`,
    );
    const [, okCount, chainCount] = /STAT_OK (\d+) (\d+)/.exec(result.stdout);
    assert.equal(
      okCount,
      chainCount,
      `every ancestor must be stat-able (got ${okCount}/${chainCount}):\n${result.stdout}`,
    );
    assert.match(
      result.stdout,
      /LIST_PROTECTED BLOCKED/,
      `listing the protected scratch-parent must stay denied:\n${result.stdout}`,
    );
    assert.match(
      result.stdout,
      /READ_SECRET BLOCKED/,
      `the sibling secret must stay unreadable:\n${result.stdout}`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- Live loopback dev-server self-test -------------------------------------
//
// A worker that runs its own test suite must be able to start a loopback TCP
// server and connect to it. This is the inbound/bind half of the network fix.

test("live: allowNetwork lets the child start and reach its own loopback TCP server", async (t) => {
  const base = makeTmp();
  try {
    const { root, state, scratch } = await makeScratchFixture(base);
    const policy = resolvePolicy({
      root,
      protectedPaths: [state],
      scratchDir: scratch,
      allowNetwork: true,
      timeoutMs: 15000,
    });

    const launcherUsable = await canApplyProfile(policy);
    if (!launcherUsable) {
      resetSandboxProbe();
      t.skip("sandbox-exec cannot apply any profile here (nested sandbox)");
      return;
    }

    const childScript = [
      "import net from 'node:net';",
      "const server = net.createServer((s) => { s.end('ok'); });",
      "await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });",
      "const port = server.address().port;",
      "const ok = await new Promise((resolve) => {",
      "  const c = net.connect({ host: '127.0.0.1', port });",
      "  const timer = setTimeout(() => { try { c.destroy(); } catch {} resolve(false); }, 5000);",
      "  c.on('connect', () => { clearTimeout(timer); c.destroy(); resolve(true); });",
      "  c.on('error', () => { clearTimeout(timer); resolve(false); });",
      "});",
      "console.log('LOOPBACK_SERVER', ok ? 'OK' : 'NO');",
      "server.close();",
    ].join("\n");

    const result = await runSandboxedCommand(
      policy,
      `/usr/bin/env node --input-type=module -e '${childScript.replace(/'/g, `'\\''`)}'`,
    );

    assert.match(
      result.stdout,
      /LOOPBACK_SERVER OK/,
      `child must be able to start+reach a loopback server:\n${result.stdout}\n${result.stderr}`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- Live network OFF --------------------------------------------------------

test("live: allowNetwork:false blocks the child from starting a loopback server", async (t) => {
  const base = makeTmp();
  try {
    const { root, state, scratch } = await makeScratchFixture(base);
    const policy = resolvePolicy({
      root,
      protectedPaths: [state],
      scratchDir: scratch,
      allowNetwork: false,
      timeoutMs: 15000,
    });

    const launcherUsable = await canApplyProfile(policy);
    if (!launcherUsable) {
      resetSandboxProbe();
      t.skip("sandbox-exec cannot apply any profile here (nested sandbox)");
      return;
    }

    const childScript = [
      "import net from 'node:net';",
      "const server = net.createServer((s) => s.end());",
      "let bound = false;",
      "try {",
      "  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });",
      "  bound = true;",
      "} catch { bound = false; }",
      "console.log('NET_OFF_LISTEN', bound ? 'OK' : 'BLOCKED');",
      "try { server.close(); } catch {}",
    ].join("\n");

    const result = await runSandboxedCommand(
      policy,
      `/usr/bin/env node --input-type=module -e '${childScript.replace(/'/g, `'\\''`)}'`,
    );

    assert.match(
      result.stdout,
      /NET_OFF_LISTEN BLOCKED/,
      `allowNetwork:false must block binding a server:\n${result.stdout}\n${result.stderr}`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- Live real-file execution (not just `-e`) --------------------------------
//
// The sandbox is meant to run a worker's own toolchain: `node script.mjs` and
// `node --test file.test.mjs` from a real on-disk file inside the project. Both
// forms exercise Node's module loader (realpath/lstat of every ancestor) and the
// test runner's child-process spawning, which an inline `-e` probe does not. The
// file is written into the project root (writable) so the loader's ancestor walk
// covers the fixture.

test("live: sandboxed `node FILE` runs a real on-disk script to exit 0", async (t) => {
  const base = makeTmp();
  try {
    const { root, state, scratch } = await makeScratchFixture(base);
    const scriptPath = path.join(root, "run-me.mjs");
    await writeFile(scriptPath, "console.log('FILE_OK', process.env.HOME ? 'HOME' : 'NOHOME');\n");

    const policy = resolvePolicy({
      root,
      protectedPaths: [state],
      scratchDir: scratch,
      timeoutMs: 20000,
    });

    const launcherUsable = await canApplyProfile(policy);
    if (!launcherUsable) {
      resetSandboxProbe();
      t.skip("sandbox-exec cannot apply any profile here (nested sandbox)");
      return;
    }
    // The layout (HOME/TMPDIR/.cache) must exist for the child to use them.
    await prepareScratchLayout(policy);

    const result = await runSandboxedCommand(
      policy,
      `/usr/bin/env node ${JSON.stringify(scriptPath)}`,
    );

    assert.equal(result.exitCode, 0, `node FILE must exit 0:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /FILE_OK HOME/, `expected script output:\n${result.stdout}`);
    // The script ran from a real file, so the loader's ancestor walk succeeded.
    assert.doesNotMatch(result.stderr, /EPERM|EACCES/, `no permission errors expected:\n${result.stderr}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("live: sandboxed `node --test FILE` runs a real on-disk test to exit 0", async (t) => {
  const base = makeTmp();
  try {
    const { root, state, scratch } = await makeScratchFixture(base);
    const testPath = path.join(root, "self.test.mjs");
    await writeFile(
      testPath,
      [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { mkdtempSync, writeFileSync } from 'node:fs';",
        "import { tmpdir } from 'node:os';",
        "import path from 'node:path';",
        "test('writes to TMPDIR', () => {",
        "  const d = mkdtempSync(path.join(tmpdir(), 'self-'));",
        "  writeFileSync(path.join(d, 'x.txt'), 'ok');",
        "  assert.ok(true);",
        "});",
      ].join("\n"),
    );

    const policy = resolvePolicy({
      root,
      protectedPaths: [state],
      scratchDir: scratch,
      timeoutMs: 30000,
    });

    const launcherUsable = await canApplyProfile(policy);
    if (!launcherUsable) {
      resetSandboxProbe();
      t.skip("sandbox-exec cannot apply any profile here (nested sandbox)");
      return;
    }
    await prepareScratchLayout(policy);

    const result = await runSandboxedCommand(
      policy,
      `/usr/bin/env node --test ${JSON.stringify(testPath)}`,
    );

    assert.equal(
      result.exitCode,
      0,
      `node --test FILE must exit 0:\n${result.stdout}\n${result.stderr}`,
    );
    assert.match(result.stdout, /pass 1/, `expected one passing test:\n${result.stdout}`);
    assert.doesNotMatch(result.stdout, /fail 1/, `no failing tests expected:\n${result.stdout}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A short canonical base dir for unix-socket fixtures.
 *
 * macOS caps a unix-domain socket path at ~104 bytes. The OS temp dir in agent
 * /CI environments is often much longer than that, so prefer a short `/tmp`
 * base and fall back to the OS temp dir (where the socket probe simply cannot
 * bind and the test skips) when `/tmp` is not writable in the nested sandbox.
 */
function shortBaseDir() {
  for (const candidate of ["/tmp", "/private/tmp"]) {
    try {
      const dir = realpathSync(mkdtempSync(path.join(candidate, "pi-sb-")));
      if (path.join(dir, "s", "scratch", "a1", "own.sock").length <= 100) return dir;
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* try next */
    }
  }
  return realpathSync(mkdtempSync(path.join(tmpdir(), "pi-sb-")));
}