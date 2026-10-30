//
// tests/checkpoints.test.mjs
//
// Real, tiny git fixtures (git init only — never committed) under a scratch
// directory created with Node's os.tmpdir(). Cleanup removes ONLY fixture
// directories whose basename matches our known prefix; there is no shell
// `rm`, no `mktemp`, no `OLDPWD`, and no write outside the fixtures.
//
//   node --experimental-strip-types --test tests/checkpoints.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createCheckpoint,
  inspectCheckpoint,
  restoreCheckpoint,
} from "../dist/checkpoints.js";

// Every fixture directory we create starts with this prefix.
const FIXTURE_PREFIX = "ckpt-fixture-";

function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), FIXTURE_PREFIX));
  return dir;
}

const cleanups = [];
function track(dir) {
  cleanups.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of cleanups) {
    // Guard: only ever remove dirs we created under the fixture prefix.
    if (!path.basename(dir).startsWith(FIXTURE_PREFIX)) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRepo() {
  const dir = track(makeFixture());
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  return dir;
}

function makePrivate() {
  const dir = track(mkdtempSync(path.join(tmpdir(), FIXTURE_PREFIX)));
  return dir;
}

function write(dir, rel, content, mode) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  if (mode !== undefined) chmodSync(abs, mode);
  return abs;
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

// ---------------------------------------------------------------------------
// capture + basic metadata
// ---------------------------------------------------------------------------

test("createCheckpoint captures files with private modes and honest counts", async () => {
  const repo = makeRepo();
  const priv = makePrivate();
  write(repo, "src/a.txt", "hello");
  write(repo, "b.bin", Buffer.from([1, 2, 3, 4]));

  const ref = await createCheckpoint(repo, priv, "cp-1");
  assert.equal(ref.complete, true, JSON.stringify(ref.reasons));
  assert.equal(ref.counts.files, 2);
  assert.equal(ref.counts.totalBytes, 5 + 4);

  // Checkpoint dir is private 0700; preimages are 0600.
  assert.equal(lstatSync(ref.dir).mode & 0o777, 0o700);
  const preimage = path.join(ref.dir, "files", "src", "a.txt");
  assert.equal(lstatSync(preimage).mode & 0o777, 0o600);
  assert.equal(readFileSync(preimage, "utf8"), "hello");
  const mf = lstatSync(path.join(ref.dir, "manifest.json"));
  assert.equal(mf.mode & 0o777, 0o600);

  const entry = ref.manifest.files.find((f) => f.path === "src/a.txt");
  assert.equal(entry.sha256, sha256("hello"));
  assert.equal(entry.mode, 0o644);
});

test("createCheckpoint refuses to overwrite an existing checkpoint", async () => {
  const repo = makeRepo();
  const priv = makePrivate();
  write(repo, "a.txt", "one");
  await createCheckpoint(repo, priv, "cp-dup");
  await assert.rejects(() => createCheckpoint(repo, priv, "cp-dup"), /already exists/);
});

test("createCheckpoint rejects an unsafe id", async () => {
  const repo = makeRepo();
  const priv = makePrivate();
  write(repo, "a.txt", "x");
  await assert.rejects(() => createCheckpoint(repo, priv, "../escape"), /invalid checkpoint id/);
  await assert.rejects(() => createCheckpoint(repo, priv, "a/b"), /invalid checkpoint id/);
});

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

test("inspectCheckpoint verifies stored preimages without touching the tree", async () => {
  const repo = makeRepo();
  const priv = makePrivate();
  write(repo, "src/a.txt", "hello");
  const ref = await createCheckpoint(repo, priv, "cp-inspect");

  const res = await inspectCheckpoint(priv, "cp-inspect");
  assert.equal(res.verified, true, JSON.stringify(res.corrupt));
  assert.equal(res.manifest.counts.files, 1);
  void ref;
});

test("inspectCheckpoint reports a corrupt preimage", async () => {
  const repo = makeRepo();
  const priv = makePrivate();
  write(repo, "src/a.txt", "hello");
  const ref = await createCheckpoint(repo, priv, "cp-corrupt");

  // Tamper with the stored preimage (simulated corruption).
  write(ref.dir, path.join("files", "src", "a.txt"), "tampered");

  const res = await inspectCheckpoint(priv, "cp-corrupt");
  assert.equal(res.verified, false);
  assert.ok(res.corrupt.some((c) => c.includes("hash mismatch")));
});

// ---------------------------------------------------------------------------
// restore: missing-only default, exact recovery
// ---------------------------------------------------------------------------

test("restoreCheckpoint recovers a deleted worker file exactly", async () => {
  const repo = makeRepo();
  const priv = makePrivate();
  write(repo, "src/a.txt", "original-content");
  write(repo, "src/nested/b.txt", "nested");
  await createCheckpoint(repo, priv, "cp-restore");

  // Simulate a worker deleting the captured files.
  rmSync(path.join(repo, "src"), { recursive: true, force: true });
  assert.equal(existsSync(path.join(repo, "src", "a.txt")), false);

  const res = await restoreCheckpoint(repo, priv, "cp-restore");
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.conflicts, []);
  assert.deepEqual(res.skipped, []);
  assert.deepEqual(res.restored.sort(), ["src/a.txt", "src/nested/b.txt"]);
  assert.equal(readFileSync(path.join(repo, "src", "a.txt"), "utf8"), "original-content");
  assert.equal(readFileSync(path.join(repo, "src", "nested", "b.txt"), "utf8"), "nested");
});

test("restoreCheckpoint never overwrites an existing human edit by default", async () => {
  const repo = makeRepo();
  const priv = makePrivate();
  write(repo, "a.txt", "original");
  await createCheckpoint(repo, priv, "cp-human");

  // A human edits the file after the checkpoint was taken.
  write(repo, "a.txt", "HUMAN-EDIT");

  const res = await restoreCheckpoint(repo, priv, "cp-human");
  assert.deepEqual(res.restored, []);
  assert.deepEqual(res.skipped, ["a.txt"]);
  assert.equal(readFileSync(path.join(repo, "a.txt"), "utf8"), "HUMAN-EDIT");
});

test("restoreCheckpoint overwrites only with an explicit overwrite flag", async () => {
  const repo = makeRepo();
  const priv = makePrivate();
  write(repo, "a.txt", "original");
  await createCheckpoint(repo, priv, "cp-over");

  write(repo, "a.txt", "changed");
  const res = await restoreCheckpoint(repo, priv, "cp-over", { overwrite: true });
  assert.deepEqual(res.restored, ["a.txt"]);
  assert.equal(readFileSync(path.join(repo, "a.txt"), "utf8"), "original");
});

// ---------------------------------------------------------------------------
// security: symlinks, protected paths, staleness
// ---------------------------------------------------------------------------

test("createCheckpoint records symlink targets as strings and never dereferences", async () => {
  const repo = makeRepo();
  const priv = makePrivate();
  // A secret outside the repo that a symlink points at.
  const outside = track(makeFixture());
  write(outside, "secret.txt", "TOP-SECRET-OUTSIDE");
  symlinkSync(path.join(outside, "secret.txt"), path.join(repo, "link.txt"));

  const ref = await createCheckpoint(repo, priv, "cp-link");
  const entry = ref.manifest.files.find((f) => f.path === "link.txt");
  assert.ok(entry, "symlink entry present");
  assert.equal(entry.kind, "symlink");
  assert.equal(entry.target, path.join(outside, "secret.txt"));
  assert.equal(entry.sha256, sha256(path.join(outside, "secret.txt")));
  // No preimage bytes were written for the link, and the secret is absent.
  assert.equal(existsSync(path.join(ref.dir, "files", "link.txt")), false);
});

test("symlink checkpoint inspects verified, then restores the exact target string", async () => {
  const repo = makeRepo();
  const priv = makePrivate();
  // A secret outside the repo, reachable only through the link's target string.
  const outside = track(makeFixture());
  write(outside, "secret.txt", "TOP-SECRET-OUTSIDE");
  const linkTarget = path.join(outside, "secret.txt");
  symlinkSync(linkTarget, path.join(repo, "link.txt"));

  await createCheckpoint(repo, priv, "cp-link-round");

  // inspect: a legitimate symlink checkpoint must verify (no stored preimage).
  const insp = await inspectCheckpoint(priv, "cp-link-round");
  assert.equal(insp.verified, true, JSON.stringify(insp.corrupt));

  // Remove the link, then restore it.
  rmSync(path.join(repo, "link.txt"));
  assert.equal(lstatSync(path.join(repo, "link.txt"), { throwIfNoEntry: false }), undefined);

  const res = await restoreCheckpoint(repo, priv, "cp-link-round");
  assert.deepEqual(res.restored, ["link.txt"], JSON.stringify(res));

  const st = lstatSync(path.join(repo, "link.txt"));
  assert.ok(st.isSymbolicLink(), "restored as a symlink (not dereferenced)");
  assert.equal(readlinkSync(path.join(repo, "link.txt")), linkTarget);
  // The secret itself is unchanged and was never copied into the checkpoint.
  assert.equal(readFileSync(path.join(outside, "secret.txt"), "utf8"), "TOP-SECRET-OUTSIDE");
  assert.equal(existsSync(path.join(priv, "cp-link-round", "files", "link.txt")), false);
});

test("restoreCheckpoint recreates a symlink inside the tree without dereferencing", async () => {
  const repo = makeRepo();
  const priv = makePrivate();
  write(repo, "real.txt", "content");
  symlinkSync("real.txt", path.join(repo, "rel-link"));
  await createCheckpoint(repo, priv, "cp-rel-link");

  rmSync(path.join(repo, "rel-link"));
  const res = await restoreCheckpoint(repo, priv, "cp-rel-link");
  assert.deepEqual(res.restored, ["rel-link"]);
  assert.equal(readlinkSync(path.join(repo, "rel-link")), "real.txt");
});

test("restoreCheckpoint refuses a checkpoint whose manifest root is another project", async () => {
  const repoA = makeRepo();
  const repoB = makeRepo();
  const priv = makePrivate();
  write(repoA, "a.txt", "from-a");
  await createCheckpoint(repoA, priv, "cp-root");

  // Restoring into repoB must be refused (manifest.root != repoB canonical root).
  await assert.rejects(() => restoreCheckpoint(repoB, priv, "cp-root"), /root mismatch/);
  assert.equal(existsSync(path.join(repoB, "a.txt")), false);
});

test("createCheckpoint excludes protected credential/config paths", async () => {
  const repo = makeRepo();
  const priv = makePrivate();
  write(repo, "keep.txt", "keep");
  write(repo, ".env", "API_KEY=leak");
  write(repo, "config.local.json", "{\"token\":\"leak\"}");
  write(repo, ".secrets/db.txt", "leak");
  write(repo, ".runtime/state", "leak");

  const ref = await createCheckpoint(repo, priv, "cp-prot");
  const paths = ref.manifest.files.map((f) => f.path);
  assert.ok(paths.includes("keep.txt"));
  for (const p of [".env", "config.local.json", ".secrets/db.txt", ".runtime/state"]) {
    assert.equal(paths.includes(p), false, `must not capture ${p}`);
  }
});

test("restoreCheckpoint refuses a path that escapes via a symlinked ancestor", async () => {
  const repo = makeRepo();
  const priv = makePrivate();
  write(repo, "sub/a.txt", "orig");
  await createCheckpoint(repo, priv, "cp-anc");

  // Replace the ancestor dir with a symlink to an outside directory.
  const outside = track(makeFixture());
  rmSync(path.join(repo, "sub"), { recursive: true, force: true });
  symlinkSync(outside, path.join(repo, "sub"));

  const res = await restoreCheckpoint(repo, priv, "cp-anc");
  assert.ok(res.errors.some((e) => e.path === "sub/a.txt"));
  assert.deepEqual(res.restored, []);
  assert.equal(existsSync(path.join(outside, "a.txt")), false);
});

test("restoreCheckpoint reports stale conflict when expectedHash mismatches", async () => {
  const repo = makeRepo();
  const priv = makePrivate();
  write(repo, "a.txt", "original");
  await createCheckpoint(repo, priv, "cp-stale");

  write(repo, "a.txt", "human-changed");
  const res = await restoreCheckpoint(repo, priv, "cp-stale", {
    overwrite: true,
    expectedHash: { "a.txt": sha256("original") },
  });
  assert.deepEqual(res.conflicts, ["a.txt"]);
  assert.deepEqual(res.restored, []);
  assert.equal(readFileSync(path.join(repo, "a.txt"), "utf8"), "human-changed");
});

test("restoreCheckpoint refuses a corrupt checkpoint preimage", async () => {
  const repo = makeRepo();
  const priv = makePrivate();
  write(repo, "a.txt", "original");
  const ref = await createCheckpoint(repo, priv, "cp-bad");

  // Corrupt the stored preimage AFTER capture.
  write(ref.dir, path.join("files", "a.txt"), "corrupted-preimage");
  rmSync(path.join(repo, "a.txt"));

  const res = await restoreCheckpoint(repo, priv, "cp-bad");
  assert.ok(res.errors.some((e) => e.reason.includes("corrupt")));
  assert.deepEqual(res.restored, []);
  assert.equal(existsSync(path.join(repo, "a.txt")), false);
});

test("restoreCheckpoint refuses a malformed manifest (bad JSON)", async () => {
  const repo = makeRepo();
  const priv = makePrivate();
  write(repo, "a.txt", "x");
  const ref = await createCheckpoint(repo, priv, "cp-malformed");

  writeFileSync(path.join(ref.dir, "manifest.json"), "{ not json ]");
  rmSync(path.join(repo, "a.txt"));

  await assert.rejects(() => restoreCheckpoint(repo, priv, "cp-malformed"), /not valid JSON/);
  assert.equal(existsSync(path.join(repo, "a.txt")), false);
});

test("inspectCheckpoint rejects a tampered manifest referencing a protected path", async () => {
  const repo = makeRepo();
  const priv = makePrivate();
  write(repo, "a.txt", "x");
  const ref = await createCheckpoint(repo, priv, "cp-tamper-prot");

  // Tamper: inject a .env entry into the manifest.
  const m = JSON.parse(readFileSync(path.join(ref.dir, "manifest.json"), "utf8"));
  m.files.push({
    path: ".env",
    kind: "file",
    sha256: sha256("SECRET=1"),
    size: 9,
    mode: 0o644,
  });
  writeFileSync(path.join(ref.dir, "manifest.json"), JSON.stringify(m));

  await assert.rejects(() => inspectCheckpoint(priv, "cp-tamper-prot"), /protected path/);
});

test("restoreCheckpoint rejects a tampered manifest with a traversal path", async () => {
  const repo = makeRepo();
  const priv = makePrivate();
  write(repo, "a.txt", "x");
  const ref = await createCheckpoint(repo, priv, "cp-tamper-trav");

  const m = JSON.parse(readFileSync(path.join(ref.dir, "manifest.json"), "utf8"));
  m.files[0].path = "../escape.txt";
  writeFileSync(path.join(ref.dir, "manifest.json"), JSON.stringify(m));

  rmSync(path.join(repo, "a.txt"));
  await assert.rejects(() => restoreCheckpoint(repo, priv, "cp-tamper-trav"), /invalid checkpoint manifest/);
  assert.equal(existsSync(path.join(repo, "..", "escape.txt")), false);
});

test("restoreCheckpoint never clobbers a file created after capture (missing-only)", async () => {
  const repo = makeRepo();
  const priv = makePrivate();
  write(repo, "a.txt", "captured");
  await createCheckpoint(repo, priv, "cp-noclobber");

  // Simulate the file being deleted, then a NEW human file appearing later.
  rmSync(path.join(repo, "a.txt"));
  write(repo, "a.txt", "human-new-content");

  const res = await restoreCheckpoint(repo, priv, "cp-noclobber");
  assert.deepEqual(res.restored, []);
  assert.deepEqual(res.skipped, ["a.txt"]);
  assert.equal(readFileSync(path.join(repo, "a.txt"), "utf8"), "human-new-content");
});

test("restoreCheckpoint overwrite preserves the original when the atomic write is refused", async () => {
  const repo = makeRepo();
  const priv = makePrivate();
  write(repo, "a.txt", "captured");
  await createCheckpoint(repo, priv, "cp-atomic");

  // Human edit after capture.
  write(repo, "a.txt", "human-edit");

  // Force a conflict via expectedHash mismatch: the original must survive intact.
  const res = await restoreCheckpoint(repo, priv, "cp-atomic", {
    overwrite: true,
    expectedHash: { "a.txt": sha256("some-other-content") },
  });
  assert.deepEqual(res.restored, []);
  assert.deepEqual(res.conflicts, ["a.txt"]);
  assert.equal(readFileSync(path.join(repo, "a.txt"), "utf8"), "human-edit");

  // A matching expectedHash overwrites atomically (no leftover temp files).
  const ok = await restoreCheckpoint(repo, priv, "cp-atomic", {
    overwrite: true,
    expectedHash: { "a.txt": sha256("human-edit") },
  });
  assert.deepEqual(ok.restored, ["a.txt"]);
  assert.equal(readFileSync(path.join(repo, "a.txt"), "utf8"), "captured");
  const leftover = readdirSync(repo).filter((n) => n.includes("ckpt-tmp-"));
  assert.deepEqual(leftover, []);
});

// ---------------------------------------------------------------------------
// bounds honesty + empty repo + selective restore + no commits
// ---------------------------------------------------------------------------

test("createCheckpoint reports incomplete when the file cap is exceeded", async () => {
  const repo = makeRepo();
  const priv = makePrivate();
  write(repo, "a.txt", "a");
  write(repo, "b.txt", "b");
  write(repo, "c.txt", "c");

  const ref = await createCheckpoint(repo, priv, "cp-cap", { maxFiles: 1 });
  assert.equal(ref.complete, false);
  assert.ok(ref.reasons.length > 0);
  assert.ok(ref.counts.files <= 1);
});

test("createCheckpoint leaves the git tree unmodified (no commits, no index change)", async () => {
  const repo = makeRepo();
  const priv = makePrivate();
  write(repo, "a.txt", "one");
  const before = git(repo, ["status", "--porcelain"]);

  await createCheckpoint(repo, priv, "cp-nogit");

  const after = git(repo, ["status", "--porcelain"]);
  assert.equal(after, before);
  // Unborn repo: `rev-parse --verify HEAD` still fails (no commit created).
  assert.throws(() => git(repo, ["rev-parse", "--verify", "HEAD"]));
});

test("restoreCheckpoint honors a selective paths list", async () => {
  const repo = makeRepo();
  const priv = makePrivate();
  write(repo, "a.txt", "A");
  write(repo, "b.txt", "B");
  await createCheckpoint(repo, priv, "cp-sel");

  rmSync(path.join(repo, "a.txt"));
  rmSync(path.join(repo, "b.txt"));

  const res = await restoreCheckpoint(repo, priv, "cp-sel", { paths: ["a.txt"] });
  assert.deepEqual(res.restored, ["a.txt"]);
  assert.equal(existsSync(path.join(repo, "a.txt")), true);
  assert.equal(existsSync(path.join(repo, "b.txt")), false);
});

test("cleanup guard only ever targets fixture-prefixed dirs", () => {
  for (const dir of cleanups) {
    assert.ok(path.basename(dir).startsWith(FIXTURE_PREFIX));
    assert.ok(dir.startsWith(tmpdir()));
  }
});

test("createCheckpoint captures the AGENTS file in a fresh unborn repo", async () => {
  const repo = makeRepo();
  const priv = makePrivate();
  // Unborn repo with no tracked files; AGENTS.md is an untracked plain file.
  write(repo, "AGENTS.md", "# agents\n");

  const ref = await createCheckpoint(repo, priv, "cp-agents");
  const paths = ref.manifest.files.map((f) => f.path);
  assert.ok(paths.includes("AGENTS.md"), JSON.stringify(paths));
  assert.equal(ref.complete, true, JSON.stringify(ref.reasons));
});

test("createCheckpoint on a truly empty repo yields an empty, complete checkpoint", async () => {
  const repo = makeRepo();
  const priv = makePrivate();

  const ref = await createCheckpoint(repo, priv, "cp-empty");
  assert.equal(ref.complete, true, JSON.stringify(ref.reasons));
  assert.equal(ref.counts.files, 0);

  const res = await inspectCheckpoint(priv, "cp-empty");
  assert.equal(res.verified, true);
});
