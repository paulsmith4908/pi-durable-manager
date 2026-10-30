// integration/verify-network.mjs
//
// Real-run diagnostic for the NETWORK policy in integration/sandbox.ts.
//
// The previous profile emitted the control-socket denials first and then a
// blanket `(allow network-inbound)/(allow network-outbound)` for the dev case.
// SBPL is last-match-wins, so the blanket allow overrode the denials and a
// sandboxed tool with `allowNetwork: true` could connect to the manager control
// unix socket. This diagnostic proves the corrected, deny-by-default policy:
//
//   * fake "control" unix server lives OUTSIDE the project and scratch trees,
//   * fake "project" unix server lives INSIDE the project tree,
//   * fake "scratch" unix server lives INSIDE the assigned scratch, which is
//     itself nested under the protected state dir (the production layout),
//   * a loopback TCP dev server is started by the parent,
//   * a child spawned through runSandboxedCommand with allowNetwork:true must be
//     able to connect to the project unix server, the scratch unix server, AND
//     the loopback TCP server, but must NOT be able to connect to the outside
//     control server — via either its raw path or a `/var` <-> `/private/var`
//     canonical alias,
//   * with allowNetwork:false neither server is reachable.
//
// The parent (this process, outside the child sandbox) hosts every server; the
// child only performs a connection probe. No protocol bytes are sent — the
// server side never accepts a connection that succeeds on a blocked socket, and
// no mutation is ever delivered. No real manager process or protocol is used.
//
// Usage (Node >= 22.19 with type stripping):
//   node --experimental-strip-types integration/verify-network.mjs
//
// Output: one compact JSON line
//   {projectUnixAllowed,scratchUnixAllowed,ipAllowed,controlUnixBlocked,aliasBlocked,networkOffBlocked,dnsAllowOnlyTrue[,registryReachable],ok}
// Exit 0 only when every condition holds. Exit 2 only when the generic nested
// launcher probe is unavailable (nested sandbox); that is a skip, never a pass.
//
// Flags (all OPTIONAL; the default run touches NO public network):
//   --dns            additionally probe the public registry from the *child* via
//                    the Node builtin `fetch` (HEAD, 10s bound). This is the
//                    real check that the OS DNS socket grant works: it needs
//                    name resolution and counts an ACTUAL HTTP 200. Off by
//                    default so the default diagnostic needs no public network.
//   --confirm-dns    parent-host positive sanity: resolve
//                    `registry.npmjs.org` in THIS process first. If the parent
//                    cannot resolve it, the child probe result is inconclusive
//                    (never counted as a pass). Only meaningful with --dns.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import { lookup } from "node:dns/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The public registry HEAD target for the optional DNS probe (network off by default). */
const REGISTRY_URL = "https://registry.npmjs.org/";
/** Hard 10s bound for the optional child registry HEAD, per the task. */
const REGISTRY_FETCH_MS = 10000;
/** True when the caller opts into the real public-network DNS probe. */
const PROBE_DNS = process.argv.includes("--dns");
/** True when the caller wants a parent-host DNS positive sanity alongside --dns. */
const CONFIRM_DNS = process.argv.includes("--confirm-dns");

/**
 * A short base directory for the fixture.
 *
 * macOS caps unix-domain socket paths at ~104 bytes; the OS temp dir in some
 * CI/agent environments is longer than that, which makes `listen()` fail with a
 * confusing EADDRINUSE. Prefer a short `/tmp` base and fall back to the OS temp
 * dir when `/tmp` is not writable (nested sandbox), where the socket probe will
 * simply be skipped by the launcher probe anyway.
 */
function shortBaseDir() {
  for (const candidate of ["/tmp", "/private/tmp"]) {
    try {
      const dir = mkdtempSync(path.join(candidate, "pi-net-"));
      // The longest socket path we will create is `<dir>/control/control.sock`.
      // darwin's sun_path is 104 bytes including the NUL. Require room to spare.
      if (path.join(dir, "control", "control.sock").length <= 100) return dir;
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* try next */
    }
  }
  return mkdtempSync(path.join(tmpdir(), "pi-net-"));
}
const {
  resolvePolicy,
  buildSandboxProfile,
  runSandboxedCommand,
  canApplyProfile,
  resetSandboxProbe,
} = await import(path.join(HERE, "..", "dist", "sandbox.js"));

/** Overall cap for a single probe child, well under the run timeout. */
const PROBE_MS = 8000;
/** How long the parent waits for a connection attempt to land. */
const ACCEPT_WAIT_MS = 1000;

/**
 * Start a unix-socket server at `sockPath`. Resolves with the server plus a
 * tracker that records whether any connection attempt was accepted.
 */
function startUnixServer(sockPath) {
  return new Promise((resolve, reject) => {
    const state = { accepted: false, sockets: [] };
    const server = net.createServer((socket) => {
      state.accepted = true;
      state.sockets.push(socket);
      socket.on("error", () => undefined);
      socket.end();
    });
    server.on("error", reject);
    server.listen(sockPath, () => resolve({ server, state }));
  });
}

/** Start a loopback TCP server; returns the port it bound to. */
function startTcpServer() {
  return new Promise((resolve, reject) => {
    const state = { accepted: false, sockets: [] };
    const server = net.createServer((socket) => {
      state.accepted = true;
      state.sockets.push(socket);
      socket.on("error", () => undefined);
      socket.end();
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, state, port: server.address().port });
    });
  });
}

/** Close a server and every socket it accepted, so nothing hangs. */
function closeServer(server, state) {
  for (const socket of state.sockets) {
    try {
      socket.destroy();
    } catch {
      /* already gone */
    }
  }
  return new Promise((resolve) => server.close(() => resolve()));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Child probe program. Connects to each candidate; prints one line per probe.
 * Everything is timed out and sockets are destroyed, so the child cannot hang.
 *
 * Each target supplies an *options object literal* (e.g. `{ path: "..." }` or
 * `{ host: "...", port: N }`) which is passed straight to `net.connect(options)`.
 * It must NOT be an already-invoked `net.connect(...)` call: doing that would
 * connect once at expression-evaluation time and then hand a live `Socket` back
 * to a second `net.connect(socket)`, which is not a valid overload and made
 * every probe report BLOCKED on a real host.
 */
function probeScript(targets) {
  const probe = (name, options) => `
    await probe(${JSON.stringify(name)}, () => (${options}));`;
  return `
import net from "node:net";
function probe(name, makeOptions) {
  return new Promise((resolve) => {
    let done = false;
    let socket;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch {}
      console.log("PROBE " + name + " " + (ok ? "OK" : "BLOCKED"));
      resolve();
    };
    const timer = setTimeout(() => finish(false), ${PROBE_MS - 2000});
    let options;
    try { options = makeOptions(); } catch { finish(false); return; }
    try { socket = net.connect(options); } catch { finish(false); return; }
    socket.on("connect", () => finish(true));
    socket.on("error", () => finish(false));
  });
}
${targets.map((t) => probe(t.name, t.options)).join("\n")}
`.trim();
}

/**
 * Child program for the optional public-network registry probe (--dns). Uses
 * the Node builtin `fetch` with an AbortController bounded to
 * `REGISTRY_FETCH_MS` (10s). Prints `REGISTRY <status>` with the ACTUAL HTTP
 * status, or `REGISTRY ERR` on any failure (DNS, TLS, timeout, non-2xx). Name
 * resolution here exercises the OS DNS socket grant under the sandbox.
 */
function registryProbeScript() {
  return `
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), ${REGISTRY_FETCH_MS});
try {
  const res = await fetch(${JSON.stringify(REGISTRY_URL)}, {
    method: "HEAD",
    redirect: "manual",
    signal: controller.signal,
  });
  console.log("REGISTRY " + res.status);
} catch {
  console.log("REGISTRY ERR");
} finally {
  clearTimeout(timer);
}
`.trim();
}

/**
 * Summarise a runSandboxedCommand result for diagnostics: child exit code plus
 * the tail of stderr, whitespace-collapsed and truncated so a failure is
 * actionable without dumping an entire stack. Never echoes credentials.
 */
function childDiagnostic(run) {
  const code = run?.exitCode ?? null;
  const stderr = String(run?.stderr ?? "").trim();
  const tail = stderr.length > 600 ? `…${stderr.slice(-600)}` : stderr;
  return { code, stderr: tail.replace(/\s+/g, " ") };
}

/** Parse PROBE lines out of child stdout into a name -> boolean map. */
function parseProbes(stdout) {
  const out = {};
  for (const line of stdout.split("\n")) {
    const m = /^PROBE (\S+) (OK|BLOCKED)$/.exec(line.trim());
    if (m) out[m[1]] = m[2] === "OK";
  }
  return out;
}

/**
 * Structural regression guard for the OS DNS socket grant.
 *
 * With `allowNetwork: true` the profile must contain exactly the known OS DNS
 * service socket as an exact `literal` allow (canonical + `/var` alias), and
 * with `allowNetwork: false` it must contain NONE. It must never emit a blanket
 * unix/network allow: no bare `(allow network-outbound)` / `network-bind` /
 * `network-inbound` without a filter, and no `(allow network-outbound (subpath
 * "/var/run"))`-style broadening. These are checked textually on the built
 * profile — no sandbox needed, so this also runs in a nested sandbox.
 */
function dnsGrantStructuralOk(onProfile, offProfile) {
  const literalAllow = (profile, p) =>
    profile.includes(`(allow network-outbound (literal "${p}"))`);
  const canonical = "/private/var/run/mDNSResponder";
  const alias = "/var/run/mDNSResponder";

  // ON: both forms present exactly as literal allows.
  if (!literalAllow(onProfile, canonical) || !literalAllow(onProfile, alias)) return false;
  // OFF: neither form present; the base `(deny network*)` still applies.
  if (literalAllow(offProfile, canonical) || literalAllow(offProfile, alias)) return false;

  // Never a blanket / subpath unix or network allow (on either profile).
  const banned = [
    /\(allow network-outbound\)/,
    /\(allow network-inbound\)/,
    /\(allow network-bind\)/,
    /\(allow network\*\)/,
    /\(allow network-outbound \(subpath "\/var\/run"\)\)/,
    /\(allow network-outbound \(subpath "\/private\/var\/run"\)\)/,
    /\(allow network-outbound \(remote unix-socket/,
  ];
  for (const re of banned) {
    if (re.test(onProfile) || re.test(offProfile)) return false;
  }

  // Ordering: the DNS allow must come AFTER the generic `/var/run` literal
  // denies and BEFORE the explicit protected-path denies, so an
  // explicitly-protected DNS path still wins (last-match-wins).
  const dnsIndex = onProfile.indexOf(`(allow network-outbound (literal "${canonical}"))`);
  const varRunDeny = onProfile.indexOf(`(deny network* (literal "/var/run"))`);
  if (dnsIndex === -1 || varRunDeny === -1 || dnsIndex < varRunDeny) return false;
  return true;
}

async function main() {
  const base = shortBaseDir();
  const result = {
    projectUnixAllowed: false,
    scratchUnixAllowed: false,
    ipAllowed: false,
    controlUnixBlocked: false,
    aliasBlocked: false,
    networkOffBlocked: false,
    dnsAllowOnlyTrue: false,
    ok: false,
  };
  let exitCode = 1;

  try {
    // Structural regression check FIRST, so it runs even when the live probes
    // are skipped (nested sandbox / long temp path). It only inspects the built
    // profile text; no sockets or sandbox-exec are needed.
    {
      const synth = {
        root: path.join(base, "proj"),
        protectedPaths: [path.join(base, "control"), path.join(base, "state")],
        scratchDir: path.join(base, "state", "scratch", "a1"),
      };
      const onProfile = buildSandboxProfile(resolvePolicy({ ...synth, allowNetwork: true }));
      const offProfile = buildSandboxProfile(resolvePolicy({ ...synth, allowNetwork: false }));
      result.dnsAllowOnlyTrue = dnsGrantStructuralOk(onProfile, offProfile);
    }

    const root = path.join(base, "proj");
    // Production layout: the assigned scratch lives *inside* the protected state
    // dir (`<state>/scratch/<id>`), not as a sibling of it. The protected state
    // dir's network subpath deny is emitted LAST, so without a carve-out it would
    // re-block the scratch's own unix socket. Mirroring the real layout here is
    // what makes this diagnostic catch that regression.
    const stateDir = path.join(base, "state");
    const scratch = path.join(stateDir, "scratch", "a1");
    await mkdir(root, { recursive: true });
    await mkdir(scratch, { recursive: true });

    // "Control" socket lives OUTSIDE the project and the protected state tree
    // (its own synthetic sibling parent; no real manager protocol is spoken).
    const controlDir = path.join(base, "control");
    await mkdir(controlDir, { recursive: true });
    const controlSock = path.join(controlDir, "control.sock");
    // Canonical alias for the same location, exercising /var <-> /private/var.
    const controlAliasSock = controlSock.replace(/^\/var\//, "/private/var/");

    // "Project" socket lives INSIDE the project tree.
    const projectSock = path.join(root, "dev.sock");
    // "Scratch" socket lives INSIDE the assigned scratch, which is itself nested
    // under the protected state dir — the production layout the carve-out guards.
    const scratchSock = path.join(scratch, "own.sock");

    // darwin sun_path is 104 bytes incl. NUL; a too-long path cannot even be
    // bound by the parent, so the probe is impossible here. Skip, never pass.
    const longest = Math.max(controlSock.length, projectSock.length, scratchSock.length);
    if (longest > 100) {
      console.error(
        JSON.stringify({
          ...result,
          ok: false,
          skipped: true,
          reason: `unix socket path too long for this OS (${longest} > 100): ${base}`,
        }),
      );
      return 2;
    }

    const control = await startUnixServer(controlSock);
    const project = await startUnixServer(projectSock);
    const scratchSrv = await startUnixServer(scratchSock);
    const tcp = await startTcpServer();

    const policy = resolvePolicy({
      root,
      // Protect BOTH the control dir (must stay blocked) and the state dir that
      // contains the assigned scratch — the latter exercises the carve-out.
      protectedPaths: [controlDir, stateDir],
      scratchDir: scratch,
    });

    // Structural regression check ran at the top of main; here we only need the
    // resolved policies for the live probes.
    const onPolicy = resolvePolicy({
      root,
      protectedPaths: [controlDir, stateDir],
      scratchDir: scratch,
      allowNetwork: true,
      timeoutMs: 15000,
    });
    const offPolicy = resolvePolicy({
      root,
      protectedPaths: [controlDir, stateDir],
      scratchDir: scratch,
      allowNetwork: false,
      timeoutMs: 15000,
    });

    // Generic launcher probe only: skip when the *environment* cannot run any
    // sandbox (nested sandbox). Never a pass.
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
      await Promise.all([
        closeServer(control.server, control.state),
        closeServer(project.server, project.state),
        closeServer(scratchSrv.server, scratchSrv.state),
        closeServer(tcp.server, tcp.state),
      ]);
      return 2;
    }

    const targets = [
      { name: "projectUnix", options: `{ path: ${JSON.stringify(projectSock)} }` },
      { name: "scratchUnix", options: `{ path: ${JSON.stringify(scratchSock)} }` },
      { name: "ipLoopback", options: `{ host: "127.0.0.1", port: ${tcp.port} }` },
      { name: "controlUnix", options: `{ path: ${JSON.stringify(controlSock)} }` },
      { name: "controlAlias", options: `{ path: ${JSON.stringify(controlAliasSock)} }` },
    ];

    // --- allowNetwork: true -------------------------------------------------
    const onRun = await runSandboxedCommand(onPolicy, `/usr/bin/env node --input-type=module -e ${shellQuote(probeScript(targets))}`);
    const on = parseProbes(onRun.stdout);

    // Give any in-flight accepted connection a moment to register before we
    // read the server-side accept flag (the child destroys its socket on done).
    await delay(ACCEPT_WAIT_MS);

    result.projectUnixAllowed = on.projectUnix === true;
    result.scratchUnixAllowed = on.scratchUnix === true;
    result.ipAllowed = on.ipLoopback === true;
    result.controlUnixBlocked = on.controlUnix !== true && control.state.accepted === false;
    result.aliasBlocked = on.controlAlias !== true;

    // --- allowNetwork: false ------------------------------------------------
    const offRun = await runSandboxedCommand(offPolicy, `/usr/bin/env node --input-type=module -e ${shellQuote(probeScript(targets))}`);
    const off = parseProbes(offRun.stdout);
    result.networkOffBlocked = off.projectUnix !== true && off.ipLoopback !== true;

    // --- Optional REAL public-network DNS probe (--dns) ---------------------
    // Off by default: the default diagnostic never needs public network. When
    // enabled, the *child* (under allowNetwork:true) does a bounded 10s HEAD to
    // the public registry via the Node builtin fetch; success requires an ACTUAL
    // HTTP 200, which in turn requires the OS DNS socket grant to work. A
    // parent-host positive sanity (--confirm-dns) first proves the name resolves
    // in THIS process, so a child failure is attributable to the sandbox, not to
    // the environment lacking DNS.
    if (PROBE_DNS) {
      if (CONFIRM_DNS) {
        try {
          const { address } = await lookup("registry.npmjs.org");
          result.dnsParentResolves = typeof address === "string" && address.length > 0;
        } catch {
          result.dnsParentResolves = false;
        }
      }
      const child = await runSandboxedCommand(
        onPolicy,
        `/usr/bin/env node --input-type=module -e ${shellQuote(registryProbeScript())}`,
      );
      const m = /REGISTRY (\d{3}|ERR)/.exec(child.stdout);
      result.registryStatus = m ? m[1] : "ERR";
      result.registryReachable = m ? m[1] === "200" : false;
    }

    result.ok =
      result.projectUnixAllowed &&
      result.scratchUnixAllowed &&
      result.ipAllowed &&
      result.controlUnixBlocked &&
      result.aliasBlocked &&
      result.networkOffBlocked &&
      result.dnsAllowOnlyTrue &&
      (!PROBE_DNS || result.registryReachable === true);

    if (result.ok) {
      console.log(JSON.stringify(result));
    } else {
      // Surface why: raw per-probe results and each child's exit/stderr tail so
      // a real-host failure is diagnosable without re-running by hand.
      console.error(
        JSON.stringify({
          ...result,
          ok: false,
          probes: { on, off },
          child: {
            on: childDiagnostic(onRun),
            off: childDiagnostic(offRun),
            controlAccepted: control.state.accepted,
          },
        }),
      );
    }
    exitCode = result.ok ? 0 : 1;

    await Promise.all([
      closeServer(control.server, control.state),
      closeServer(project.server, project.state),
      closeServer(scratchSrv.server, scratchSrv.state),
      closeServer(tcp.server, tcp.state),
    ]);
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

/** POSIX single-quote a string for `/bin/zsh -c`. */
function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

process.exit(await main());
