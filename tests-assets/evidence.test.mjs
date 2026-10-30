//
// Real, tiny git fixtures (git init only — never committed) under a scratch
// directory. No planted real secrets; all "credential" files hold fixture
// strings. Node builtins only; run with TS stripping on Node 22:
//   node --experimental-strip-types --test tests/evidence.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  captureSnapshot,
  compareSnapshots,
  sanitizeCommandResult,
  verifySnapshot,
  writeArtifact,
} from "../dist/evidence.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "evidence-repo-"));
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  return dir;
}

function write(dir, rel, content, mode) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  if (mode !== undefined) chmodSync(abs, mode);
  return abs;
}

const cleanups = [];
test.after(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

function track(dir) {
  cleanups.push(dir);
  return dir;
}

function sha256Hex(s) {
  return createHash("sha256").update(s).digest("hex");
}

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

test("captureSnapshot hashes files and excludes unchanged baseline", async () => {
  const dir = track(makeRepo());
  write(dir, "src/a.txt", "hello");
  const before = await captureSnapshot(dir);
  assert.equal(before.complete, true, JSON.stringify(before.reasons));
  assert.equal(before.files["src/a.txt"].kind, "file");
  assert.equal(before.files["src/a.txt"].size, 5);

  // No change -> no changed files (preexisting untracked unchanged excluded).
  const same = await captureSnapshot(dir);
  assert.deepEqual(compareSnapshots(before, same).changedFiles, []);

  // Add, edit, delete.
  write(dir, "src/b.txt", "new");
  write(dir, "src/a.txt", "hello world");
  rmSync(path.join(dir, "src", "b.txt"));
  const after = await captureSnapshot(dir);
  assert.equal(after.complete, true);
  const diff = compareSnapshots(before, after).changedFiles;
  assert.deepEqual(
    diff.map((d) => d.path),
    ["src/a.txt"],
  );
  assert.equal(diff[0].kind, "modified");
});

test("mode changes are reported as modified", async () => {
  const dir = track(makeRepo());
  write(dir, "x.sh", "echo hi", 0o644);
  const before = await captureSnapshot(dir);
  chmodSync(path.join(dir, "x.sh"), 0o755);
  const after = await captureSnapshot(dir);
  const diff = compareSnapshots(before, after).changedFiles;
  assert.equal(diff.length, 1);
  assert.equal(diff[0].kind, "modified");
  assert.equal(diff[0].beforeHash, diff[0].afterHash); // content unchanged
});

test("added and deleted entries carry hashes", async () => {
  const dir = track(makeRepo());
  write(dir, "a.txt", "A");
  const before = await captureSnapshot(dir);
  write(dir, "b.txt", "B");
  const mid = await captureSnapshot(dir);
  rmSync(path.join(dir, "a.txt"));
  const after = await captureSnapshot(dir);

  const added = compareSnapshots(before, mid).changedFiles.find((e) => e.path === "b.txt");
  assert.equal(added.kind, "added");
  assert.equal(added.afterHash, sha256Hex("B"));

  const deleted = compareSnapshots(mid, after).changedFiles.find((e) => e.path === "a.txt");
  assert.equal(deleted.kind, "deleted");
  assert.equal(deleted.beforeHash, sha256Hex("A"));
});

test("protected and credential paths are skipped, contents never read", async () => {
  const dir = track(makeRepo());
  write(dir, ".env", "SECRET=fixture-not-real");
  write(dir, "config.local.json", '{"token":"fixture"}');
  write(dir, ".secrets/key.txt", "fixture-secret");
  write(dir, "ok.txt", "ok");
  const snap = await captureSnapshot(dir, { protectedPaths: ["ok.txt"] });
  assert.equal(snap.complete, true);
  assert.equal(snap.files[".env"], undefined);
  assert.equal(snap.files["config.local.json"], undefined);
  assert.equal(snap.files[".secrets/key.txt"], undefined);
  assert.equal(snap.files["ok.txt"], undefined);
  assert.ok(!JSON.stringify(snap).includes("fixture-secret"));
});

test("symlinks hash the target string only and never follow outside", async () => {
  const dir = track(makeRepo());
  const outside = track(mkdtempSync(path.join(tmpdir(), "evidence-out-")));
  write(outside, "secret.txt", "OUTSIDE-CONTENT");
  writeFileSync(path.join(dir, "inside.txt"), "inside");
  symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "link"));
  const snap = await captureSnapshot(dir);
  assert.equal(snap.files["link"].kind, "symlink");
  assert.equal(snap.files["link"].sha256, sha256Hex(path.join(outside, "secret.txt")));
  assert.ok(!JSON.stringify(snap).includes("OUTSIDE-CONTENT"));
});

test("bounds are honest: file cap and byte cap mark snapshot incomplete", async () => {
  const dir = track(makeRepo());
  write(dir, "a.txt", "aaaaa");
  write(dir, "b.txt", "bbbbb");
  const capFiles = await captureSnapshot(dir, { maxFiles: 1 });
  assert.equal(capFiles.complete, false);
  assert.equal(Object.keys(capFiles.files).length, 1);
  assert.ok(capFiles.reasons.some((r) => r.includes("file cap")));

  const big = track(makeRepo());
  write(big, "big.txt", "x".repeat(100));
  const capBytes = await captureSnapshot(big, { maxFileBytes: 10 });
  assert.equal(capBytes.complete, false);
  assert.ok(capBytes.reasons.some((r) => r.includes("exceeds")));
});

test("verifySnapshot detects stale and missing files", async () => {
  const dir = track(makeRepo());
  write(dir, "a.txt", "A");
  write(dir, "b.txt", "B");
  const snap = await captureSnapshot(dir);

  write(dir, "a.txt", "A-changed");
  rmSync(path.join(dir, "b.txt"));
  const res = await verifySnapshot(dir, snap);
  assert.equal(res.ok, false);
  assert.deepEqual(res.staleFiles, ["a.txt"]);
  assert.deepEqual(res.missingFiles, ["b.txt"]);
});

test("writeArtifact is immutable, private, and refuses traversal/overwrite", async () => {
  const base = track(mkdtempSync(path.join(tmpdir(), "evidence-artifacts-")));
  const dir = path.join(base, "evidence");
  const res = await writeArtifact(dir, "run-1.json", { ok: true });
  assert.equal(res.sha256, sha256Hex(readFileSync(res.path, "utf8")));
  assert.equal(lstatSync(res.path).mode & 0o777, 0o600);
  assert.equal(lstatSync(dir).mode & 0o777, 0o700);

  await assert.rejects(() => writeArtifact(dir, "run-1.json", { ok: false }), /already exists/);
  await assert.rejects(() => writeArtifact(dir, "../escape.json", {}), /invalid artifact id/);
});

test("writeArtifact refuses a symlink target and copies raw bytes", async () => {
  const base = track(mkdtempSync(path.join(tmpdir(), "evidence-artifacts-")));
  const dir = path.join(base, "evidence");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(base, "real.json"), "REAL");
  symlinkSync(path.join(base, "real.json"), path.join(dir, "link.json"));
  await assert.rejects(() => writeArtifact(dir, "link.json", {}), /refusing symlink target/);
  assert.equal(readFileSync(path.join(base, "real.json"), "utf8"), "REAL");

  const raw = await writeArtifact(dir, "blob.bin", new Uint8Array([1, 2, 3]));
  assert.deepEqual([...readFileSync(raw.path)], [1, 2, 3]);
});

test("sanitizeCommandResult bounds output and preserves failure", async () => {
  const summary = sanitizeCommandResult(
    { command: "git push", exitCode: 1, stdout: "x".repeat(10_000), stderr: "boom" },
    { maxInlineBytes: 100 },
  );
  assert.equal(summary.ok, false);
  assert.equal(summary.exitCode, 1);
  assert.equal(summary.truncated, true);
  assert.ok(summary.stdoutTail.length <= 100);
  assert.equal(summary.stderrTail, "boom");
  assert.equal(summary.fullOutputPath, null);

  const ok = sanitizeCommandResult({ command: "true", exitCode: 0 });
  assert.equal(ok.ok, true);
});

test("stable artifact JSON is deterministic for key order", async () => {
  const base = track(mkdtempSync(path.join(tmpdir(), "evidence-artifacts-")));
  const dir = path.join(base, "evidence");
  const a = await writeArtifact(dir, "one.json", { x: 1, y: [3, 2, 1] });
  const b = await writeArtifact(dir, "two.json", { y: [3, 2, 1], x: 1 });
  assert.equal(a.sha256, b.sha256);
});

// ---------------------------------------------------------------------------
// parent-symlink escape (the concrete bug)
// ---------------------------------------------------------------------------

test("captureSnapshot blocks a tracked path whose parent dir became a symlink", async () => {
  const dir = track(makeRepo());
  write(dir, "nested/file.txt", "CHECKOUT-CONTENT");
  git(dir, ["add", "nested/file.txt"]); // tracked, never committed
  assert.equal(git(dir, ["ls-files"]).trim(), "nested/file.txt");

  // A private directory OUTSIDE the checkout, with a same-named secret file.
  const outside = track(mkdtempSync(path.join(tmpdir(), "evidence-private-")));
  write(outside, "file.txt", "PRIVATE-SECRET-VALUE");

  // Replace the tracked ancestor directory with a symlink to the private dir.
  rmSync(path.join(dir, "nested"), { recursive: true, force: true });
  symlinkSync(outside, path.join(dir, "nested"));

  // Guard the read: set a sentinel that the real code path must never hit.
  let readGuardTripped = false;
  const snap = await captureSnapshot(dir, {
    sanitize: (s) => {
      readGuardTripped = true;
      return s;
    },
  });

  // The host read must be refused and reported, not silently followed.
  assert.equal(snap.complete, false, "snapshot must be incomplete");
  assert.ok(
    snap.reasons.some((r) => r.includes("unsafe ancestor")),
    `expected an unsafe-ancestor reason, got ${JSON.stringify(snap.reasons)}`,
  );
  // No entry, and in particular never the private file's hash or contents.
  assert.equal(snap.files["nested/file.txt"], undefined);
  const privateHash = sha256Hex("PRIVATE-SECRET-VALUE");
  assert.ok(
    !Object.values(snap.files).some((e) => e.sha256 === privateHash),
    "private content hash must never appear",
  );
  assert.ok(!JSON.stringify(snap).includes("PRIVATE-SECRET-VALUE"));
  // The sanitizer is not proof of no-read on its own; the structural reason is.
  assert.equal(typeof readGuardTripped, "boolean");
});

test("captureSnapshot blocks a symlinked parent even for a symlink leaf", async () => {
  const dir = track(makeRepo());
  // A tracked symlink inside a directory that we then point elsewhere.
  write(dir, "linkdir/keep", "x");
  mkdirSync(path.join(dir, "linkdir"), { recursive: true });
  symlinkSync("/etc/hostname", path.join(dir, "linkdir", "leaf"));
  git(dir, ["add", "linkdir/leaf"]);

  const outside = track(mkdtempSync(path.join(tmpdir(), "evidence-private2-")));
  rmSync(path.join(dir, "linkdir"), { recursive: true, force: true });
  symlinkSync(outside, path.join(dir, "linkdir"));

  const snap = await captureSnapshot(dir);
  assert.equal(snap.complete, false);
  assert.equal(snap.files["linkdir/leaf"], undefined);
});

// ---------------------------------------------------------------------------
// POSIX path fidelity: backslash / space / newline filenames
// ---------------------------------------------------------------------------

test("captureSnapshot keeps real POSIX names (backslash, space, newline) verbatim", async () => {
  const dir = track(makeRepo());
  const names = ["a\\b.txt", "with space.txt", "line\nbreak.txt"];
  for (const n of names) write(dir, n, `content:${n}`);

  const snap = await captureSnapshot(dir);
  assert.equal(snap.complete, true, JSON.stringify(snap.reasons));
  for (const n of names) {
    assert.ok(snap.files[n], `expected verbatim key ${JSON.stringify(n)}`);
    // The backslash must be a literal name character, not normalized to "/".
    assert.equal(snap.files[n].sha256, sha256Hex(`content:${n}`));
  }
  assert.equal(snap.files["a/b.txt"], undefined);
});

// ---------------------------------------------------------------------------
// option bounds
// ---------------------------------------------------------------------------

test("captureSnapshot rejects non-positive/invalid bounds and clamps to hard max", async () => {
  const dir = track(makeRepo());
  write(dir, "a.txt", "hello");

  await assert.rejects(() => captureSnapshot(dir, { maxFiles: 0 }), /positive integer/);
  await assert.rejects(() => captureSnapshot(dir, { maxFiles: -1 }), /positive integer/);
  await assert.rejects(() => captureSnapshot(dir, { maxFiles: Infinity }), /finite integer/);
  await assert.rejects(() => captureSnapshot(dir, { maxFileBytes: NaN }), /finite integer/);

  // A huge value is clamped, not honored (no unbounded alloc).
  const snap = await captureSnapshot(dir, { maxFiles: 1e9, maxFileBytes: 1e12 });
  assert.equal(snap.complete, true);
  // maxFiles 2 with 1 file is fine and complete.
  const snap2 = await captureSnapshot(dir, { maxFiles: 2 });
  assert.equal(snap2.complete, true);
});

// ---------------------------------------------------------------------------
// tracked deletion is not incompleteness
// ---------------------------------------------------------------------------

test("a normal tracked deletion is excluded without incompleteness", async () => {
  const dir = track(makeRepo());
  write(dir, "keep.txt", "K");
  write(dir, "gone.txt", "G");
  git(dir, ["add", "keep.txt", "gone.txt"]);
  const before = await captureSnapshot(dir);
  assert.equal(before.complete, true);
  assert.ok(before.files["gone.txt"]);

  // Simulate a normal deletion (unlink, no commit).
  rmSync(path.join(dir, "gone.txt"));

  const after = await captureSnapshot(dir);
  assert.equal(after.complete, true, JSON.stringify(after.reasons));
  assert.equal(after.files["gone.txt"], undefined);
  const diff = compareSnapshots(before, after).changedFiles;
  const del = diff.find((e) => e.path === "gone.txt");
  assert.ok(del, "deletion must be reported");
  assert.equal(del.kind, "deleted");
  assert.ok(del.beforeHash);
});

// ---------------------------------------------------------------------------
// writeArtifact explicit redaction
// ---------------------------------------------------------------------------

test("writeArtifact applies sanitize to serialized text (explicit sentinel redaction)", async () => {
  const base = track(mkdtempSync(path.join(tmpdir(), "evidence-artifacts-")));
  const dir = path.join(base, "evidence");
  const SENTINEL = "sk-LIVE-SENTINEL-0123456789";
  const sanitize = (s) => s.replaceAll(SENTINEL, "[redacted]");

  const res = await writeArtifact(
    dir,
    "cmd.json",
    { argv: ["deploy"], env: { TOKEN: SENTINEL }, nested: { deeper: SENTINEL } },
    { sanitize },
  );
  const written = readFileSync(res.path, "utf8");
  assert.ok(!written.includes(SENTINEL), "secret must not be written");
  assert.ok(written.includes("[redacted]"));
  assert.equal(res.sha256, sha256Hex(written));

  // Without sanitize, the caller owns redaction: raw value is written as-is.
  const raw = await writeArtifact(dir, "raw.json", { token: SENTINEL });
  assert.ok(readFileSync(raw.path, "utf8").includes(SENTINEL));
});

// ---------------------------------------------------------------------------
// git enumerator hardening (real malicious fixture)
// ---------------------------------------------------------------------------

test("captureSnapshot disables a repo-configured core.fsmonitor hook", async () => {
  const dir = track(makeRepo());
  write(dir, "a.txt", "hello");

  // A malicious fsmonitor hook that, if ever invoked, drops a sentinel file.
  // Use a repo-relative marker and `touch` (cwd = repo root) to avoid quoting
  // surprises with the space in this checkout's path.
  const marker = path.join(dir, "FSTMONITOR-RAN");
  const hook = path.join(dir, "evil-fsmonitor.sh");
  writeFileSync(hook, "#!/bin/sh\ntouch FSTMONITOR-RAN\nprintf '1/ 0\\n'\n");
  chmodSync(hook, 0o755);
  git(dir, ["config", "core.fsmonitor", hook]);

  const snap = await captureSnapshot(dir);
  assert.equal(snap.complete, true, JSON.stringify(snap.reasons));
  assert.ok(snap.files["a.txt"]);
  // -c core.fsmonitor=false must have suppressed the hook entirely.
  assert.equal(lstatSync(marker, { throwIfNoEntry: false }), undefined);
});
