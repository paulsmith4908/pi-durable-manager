import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { startOnboarding, discoverModels, validateEndpoint, configureService } from "../plugin/skills/pi-durable-manager/scripts/onboard.mjs";
import { installRuntime, privateDir } from "../plugin/skills/pi-durable-manager/scripts/runtime-install.mjs";

test("setup rejects credential-bearing/unsafe URLs before contacting a provider", () => {
  for (const url of ["http://provider.example/v1", "https://key@provider.example/v1", "https://provider.example/v1?key=fixture", "file:///tmp/a", "https://provider.example/#fixture"]) {
    assert.throws(() => validateEndpoint(url));
  }
  assert.equal(validateEndpoint("https://provider.example/v1/"), "https://provider.example/v1");
  assert.equal(validateEndpoint("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234/v1");
});

test("model discovery sends authentication only to the chosen endpoint and rejects redirects", async () => {
  let seen;
  const provider = createServer((req, res) => {
    seen = req.headers.authorization;
    if (req.url === "/redirect/models") { res.writeHead(302, { Location: "/v1/models" }); res.end(); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "fixture-model" }, { id: "fixture-model" }, { id: 42 }] }));
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${provider.address().port}`;
    assert.deepEqual(await discoverModels(`${base}/v1`, "synthetic-fixture-token"), ["fixture-model"]);
    assert.equal(seen, "Bearer synthetic-fixture-token");
    await assert.rejects(() => discoverModels(`${base}/redirect`, "synthetic-fixture-token"));
  } finally { await new Promise(resolve => provider.close(resolve)); }
});

test("setup UI blocks cross-origin/unauthenticated mutations and duplicate installs, and never returns a key", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-onboard-test-"));
  let release; let installs = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const app = await startOnboarding({ dataHome: home, configure: async input => {
    installs++; assert.equal(input.key, "synthetic-fixture-token"); await gate;
    return { version: "fixture", configPath: join(home, "config.json"), serviceHealthy: true };
  } });
  const url = new URL(app.url); const base = url.origin;
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json", Origin: base };
  try {
    assert.equal((await fetch(`${base}/api/status`)).status, 403);
    assert.equal((await fetch(`${base}/api/install`, { method: "POST", headers: { ...headers, Origin: "https://attacker.example" }, body: "{}" })).status, 403);
    assert.equal(installs, 0);
    const html = await fetch(base);
    assert.match(html.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.ok(!(await html.text()).includes(url.hash.slice(1)));
    const body = JSON.stringify({ endpoint: "https://provider.example/v1", model: "fixture", contextWindow:32768,maxTokens:4096, key: "synthetic-fixture-token", allowNetwork: false });
    assert.equal((await fetch(`${base}/api/install`, { method: "POST", headers, body })).status, 202);
    assert.equal((await fetch(`${base}/api/install`, { method: "POST", headers, body })).status, 409);
    release();
    for (let i = 0; i < 20; i++) {
      const result = await fetch(`${base}/api/status`, { headers }); const text = await result.text();
      assert.ok(!text.includes("synthetic-fixture-token"));
      if (JSON.parse(text).phase === "done") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(installs, 1);
    assert.equal((await (await fetch(`${base}/api/status`, { headers })).json()).phase, "done");
  } finally { release(); await app.close(); await rm(home, { recursive: true, force: true }); }
});

test("first-use setup preserves existing configuration and refuses a symlinked data directory", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-onboard-preserve-"));
  try {
    const home = join(base, "home"); await mkdir(home, { mode: 0o700 });
    const original = '{"existing":"synthetic fixture configuration"}\n';
    await writeFile(join(home, "config.json"), original, { mode: 0o600 });
    let called = false;
    await assert.rejects(() => configureService({ endpoint: "https://provider.example/v1", model: "fixture", contextWindow:32768,maxTokens:4096, noAuth: true, allowNetwork: false }, {
      dataHome: home, progress() {}, installer: async () => { called = true; },
    }), /already exists/);
    assert.equal(called, false);
    assert.equal(await readFile(join(home, "config.json"), "utf8"), original);
    const link = join(base, "alias"); await symlink(home, link);
    await assert.rejects(() => privateDir(link), /non-symlink/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("runtime installation rejects a tampered embedded package before npm executes", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-onboard-integrity-"));
  try {
    const pluginRoot = join(base, "plugin"); await mkdir(join(pluginRoot, "service"), { recursive: true });
    await writeFile(join(pluginRoot, "service/runtime.json"), JSON.stringify({ file: "pi-durable-manager-fixture.tgz", version: "fixture", sha256: "0".repeat(64) }));
    await writeFile(join(pluginRoot, "service/pi-durable-manager-fixture.tgz"), "tampered fixture package");
    await assert.rejects(() => installRuntime({ dataHome: join(base, "home"), pluginRoot }), /checksum mismatch/);
    assert.equal((await stat(join(base, "home"))).mode & 0o777, 0o700);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("uncertain service startup preserves its config and credential reference for review", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-onboard-start-failure-"));
  try {
    const runtime = join(base, "runtime");
    await mkdir(join(runtime, "bin"), { recursive: true });
    await mkdir(join(runtime, "dist"));
    await writeFile(join(runtime, "package.json"), '{"type":"module"}');
    await writeFile(join(runtime, "dist/cli-setup.js"), 'export function discoverAppExecutable(){return "/usr/bin/true";}');
    const bin = join(runtime, "bin/pi-durable.js");
    await writeFile(bin, `import {writeFileSync} from 'node:fs';
      const args=process.argv.slice(2); const value=name=>args[args.indexOf(name)+1];
      if(args[0]==='setup'){
        writeFileSync(value('--config'),JSON.stringify({limits:{contextWindow:65536,maxTokens:16384},credential:{apiKeyFile:value('--credential-file')}}),{mode:0o600});
        console.log(JSON.stringify({ok:true,result:{checks:[{id:'codex',level:'pass'}]}}));
      }else{process.exit(1);}`);
    const dataHome = join(base, "home");
    await assert.rejects(() => configureService({ endpoint: "https://provider.example/v1", model: "fixture", contextWindow:32768,maxTokens:4096, key: "synthetic-fixture-token", allowNetwork: false }, {
      dataHome, progress() {}, installer: async () => ({ bin, version: "fixture" }),
    }), /preserved/);
    const config = JSON.parse(await readFile(join(dataHome, "config.json"), "utf8"));
    assert.equal((await stat(config.credential.apiKeyFile)).mode & 0o777, 0o600);
    await assert.rejects(() => stat(join(dataHome, "installation.json")), { code: "ENOENT" });
    await assert.rejects(() => stat(join(dataHome, "setup.lock")), { code: "ENOENT" });
  } finally { await rm(base, { recursive: true, force: true }); }
});
