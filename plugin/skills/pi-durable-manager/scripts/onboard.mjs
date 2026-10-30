#!/usr/bin/env node
// Explicit, temporary loopback setup UI. Secrets remain between the user's browser and this process.
import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, lstat, rename, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_HOME, PLUGIN_ROOT, privateDir, privateWrite, installRuntime, readInstallation, run } from "./runtime-install.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAFE_FAILURE = "Setup did not complete. Check Git, Codex queue support, the endpoint, and network access, then retry. Existing installations were preserved.";

export function validateEndpoint(value, allowInsecureHttp = false) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && (allowInsecureHttp || ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))))) {
    throw new Error("Use an HTTPS API base URL without a key in the URL. HTTP is allowed only on loopback.");
  }
  return url.href.replace(/\/+$/, "");
}

export async function discoverModels(endpoint, key = "", allowInsecureHttp = false) {
  endpoint = validateEndpoint(endpoint, allowInsecureHttp);
  const response = await fetch(`${endpoint}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    redirect: "error", signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("Model discovery unavailable. Check authentication, or enter the exact model ID manually.");
  // Bound provider-controlled data; never echo its errors or arbitrary response bytes.
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length; if (size > 262144) { await reader.cancel(); throw new Error("Model list is too large; enter a model ID manually."); }
    chunks.push(value);
  }
  const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return [...new Set((data.data || []).map(row => row.id).filter(id => typeof id === "string" && id.length > 0 && id.length <= 512))].slice(0, 200);
}

async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export async function configureService(input, { dataHome, pluginRoot, progress, installer = installRuntime }) {
  const endpoint = validateEndpoint(input.endpoint, input.allowInsecureHttp === true);
  for (const k of ["contextWindow", "maxTokens"]) if (!Number.isSafeInteger(input[k]) || input[k] < 1 || input[k] > 10000000) throw new Error("Enter your model server’s context and output token limits.");
  if (input.maxTokens >= input.contextWindow) throw new Error("Output limit must be smaller than context window.");
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!model || model.length > 512 || /[\r\n\x00]/.test(model)) throw new Error("Choose or enter the exact model ID.");
  if (input.key && (typeof input.key !== "string" || input.key.length > 8192 || /[\r\n\x00]/.test(input.key))) throw new Error("Invalid API key format.");
  if (!input.key && input.noAuth !== true) throw new Error("Enter an API key privately, or confirm that your endpoint needs no authentication.");
  if (typeof input.allowNetwork !== "boolean") throw new Error("Choose whether worker development networking is permitted.");
  await privateDir(dataHome);
  const configPath = join(dataHome, "config.json");
  if (await exists(configPath) || await exists(join(dataHome, "installation.json"))) {
    throw new Error("An installation already exists. Setup will not replace its endpoint or credentials. Ask Codex to inspect that installation.");
  }
  const lease = join(dataHome, "setup.lock");
  await privateWrite(lease, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), true)
    .catch(() => { throw new Error("Another setup may be active. Review setup.lock before retrying."); });
  let credentialPath; let configWritten = false; let startAttempted = false;
  try {
    const runtime = await installer({ dataHome, pluginRoot, progress });
    const { discoverAppExecutable } = await import(pathToFileURL(join(dirname(runtime.bin), "../dist/cli-setup.js")).href);
    const codex = discoverAppExecutable();
    if (!codex) throw new Error("A compatible Codex installation is required.");
    await privateDir(join(dataHome, "credentials"));
    credentialPath = join(dataHome, "credentials", `${randomUUID()}.key`);
    // Auth-free endpoints still receive a harmless non-secret bearer value from the current transport.
    await privateWrite(credentialPath, input.key || "pi-durable-no-auth", true);
    input.key = "";
    progress("Configuring your private workspace…");
    const args = [runtime.bin, "setup", "--endpoint", endpoint, "--model", model,
      "--credential-file", credentialPath, "--config", configPath,
      "--state-dir", join(dataHome, "state"), "--project-home", join(dataHome, "projects"),
      "--install-target", "none", "--compatibility-preset", "generic", "--codex-executable", codex, "--json"];
    if (input.allowNetwork) args.push("--allow-network");
    if (input.allowInsecureHttp) args.push("--allow-insecure-http");
    const setup = JSON.parse(await run(process.execPath, args));
    if (!setup.ok) throw new Error(SAFE_FAILURE);
    configWritten = true;
    // This is the new config just generated above; never replace an existing installation.
    const generated = JSON.parse(await readFile(configPath, "utf8"));
    generated.limits.contextWindow=input.contextWindow; generated.limits.maxTokens=input.maxTokens;
    generated.reasoning=input.reasoning===true;
    if(input.noAuth) generated.credential={none:true};
    const configured=join(dataHome,`.config-${randomUUID()}.json`);
    await privateWrite(configured,JSON.stringify(generated,null,2)+"\n",true);
    await rename(configured,configPath);

    const checks = setup.result?.checks || [];
    if (checks.some(c => c.id === "codex" && c.level !== "pass")) throw new Error("Compatible Codex queue support is required for automatic manager wake-up.");
    progress("Starting Pi Durable…");
    startAttempted = true;
    const start = JSON.parse(await run(process.execPath, [runtime.bin, "service", "start", "--config", configPath, "--json"]));
    if (!start.ok || !start.result.ok || start.result.alreadyRunning) throw new Error("A service conflict was detected. Review the existing process before retrying.");
    const status = JSON.parse(await run(process.execPath, [runtime.bin, "service", "status", "--config", configPath, "--json"]));
    if (!status.ok || !status.result.running || status.result.status.packageVersion !== runtime.version) throw new Error(SAFE_FAILURE);
    const installation = {
      schemaVersion: 1, version: runtime.version, payloadSha256: runtime.sha256,
      node: process.execPath, bin: runtime.bin, configPath, dataHome,
      installedAt: new Date().toISOString(), serviceHealthy: true, providerCodingVerified: false,
    };
    const staged = join(dataHome, `.installation-${randomUUID()}.json`);
    await privateWrite(staged, JSON.stringify(installation, null, 2) + "\n", true);
    await rename(staged, join(dataHome, "installation.json"));
    return installation;
  } catch (error) {
    // A running process may own this config. Preserve it for review instead of rolling it back.
    if (!startAttempted) {
      if (configWritten) await rm(configPath, { force: true });
      // If a failed setup command left an on-disk config, keep its reference valid for review.
      if (credentialPath && !(await exists(configPath))) await rm(credentialPath, { force: true });
    }
    // No raw exception/provider/npm output crosses into the browser or Codex transcript.
    throw new Error(startAttempted ? "Service startup or final verification failed. Ask Codex to inspect it before retrying; its config was preserved." : SAFE_FAILURE);
  } finally { input.key = ""; await rm(lease, { force: true }); }
}

export async function startOnboarding({ dataHome = process.env.PI_DURABLE_HOME || DEFAULT_HOME, pluginRoot = PLUGIN_ROOT, configure = configureService } = {}) {
  dataHome = resolve(dataHome);
  const token = randomBytes(32).toString("hex");
  let origin; let busy = false;
  const state = { phase: "ready", message: "Enter your model endpoint to set up Pi Durable.", installation: null };
  const existing = await readInstallation(dataHome);
  if (existing) { state.phase = "existing"; state.message = "Pi Durable is already configured. Ask Codex to check its status; setup will preserve it."; }
  const send = (response, status, value, type = "application/json") => {
    response.writeHead(status, {
      "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    response.end(type === "application/json" ? JSON.stringify(value) : value);
  };
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== new URL(origin).host) return send(response, 403, { error: "Invalid host." });
      const path = new URL(request.url, origin).pathname;
      const assets = { "/": ["onboard.html", "text/html; charset=utf-8"], "/app.js": ["onboard-ui.js", "text/javascript"], "/style.css": ["onboard.css", "text/css"] };
      if (request.method === "GET" && assets[path]) {
        const [file, type] = assets[path]; return send(response, 200, await readFile(join(HERE, file)), type);
      }
      const authorization = request.headers.authorization || "";
      const expected = `Bearer ${token}`;
      if (authorization.length !== expected.length || !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))) return send(response, 403, { error: "Open the private setup link from Codex." });
      if (request.method === "GET" && path === "/api/status") return send(response, 200, state);
      if (request.method !== "POST" || request.headers.origin !== origin || request.headers["content-type"] !== "application/json") return send(response, 403, { error: "Invalid setup request." });
      let size = 0; const chunks = [];
      for await (const chunk of request) { size += chunk.length; if (size > 16384) return send(response, 413, { error: "Request too large." }); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (path === "/api/models") {
        try { return send(response, 200, { models: await discoverModels(input.endpoint, input.key, input.allowInsecureHttp === true) }); }
        catch { return send(response, 400, { error: "Could not discover models. Check the endpoint/key, or enter a model ID manually." }); }
        finally { input.key = ""; }
      }
      if (path !== "/api/install") return send(response, 404, { error: "Unknown setup action." });
      if (busy || state.phase === "done" || existing) return send(response, 409, { error: "Setup is already active or an installation exists." });
      busy = true; state.phase = "installing"; state.message = "Preparing your runtime…";
      send(response, 202, { accepted: true });
      try {
        const installation = await configure(input, { dataHome, pluginRoot, progress: message => { state.message = message; } });
        state.phase = "done"; state.message = "Pi Durable is ready. Return to Codex and ask it to use Pi for a task.";
        state.installation = { version: installation.version, configPath: installation.configPath, serviceHealthy: installation.serviceHealthy, providerCodingVerified: false };
      } catch { state.phase = "failed"; state.message = SAFE_FAILURE; }
      finally { input.key = ""; busy = false; }
    } catch { if (!response.headersSent) send(response, 400, { error: "Invalid setup request." }); else response.end(); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000;
  await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/#${token}`;
  return { server, url, dataHome, close: () => new Promise(resolvePromise => server.close(resolvePromise)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes("--help")) {
    console.log("Explicit Pi first-use setup. Open the returned private loopback link; enter credentials only in that page. No install hooks or automatic delegation. PI_DURABLE_HOME overrides the private data directory.");
  } else if (process.platform !== "darwin") {
    console.error("Pi Durable setup currently supports macOS only."); process.exitCode = 1;
  } else {
    const app = await startOnboarding();
    console.log(JSON.stringify({ setupUrl: app.url, dataHome: app.dataHome, note: "Open this private local setup page. Do not put API keys in chat." }));
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { app.server.closeAllConnections(); app.server.close(() => process.exit(0)); });
  }
}
