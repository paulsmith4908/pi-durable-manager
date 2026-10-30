import { test } from "node:test";
import assert from "node:assert/strict";
import { readPage, READ_PAGE_BYTES } from "../src/read-page.js";
import { workerCompactionPolicy } from "../src/context-policy.js";
import { rememberTool, workMemoryMessage, type WorkMemory } from "../src/work-memory.js";
import { MetadataStore } from "../src/store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("bounded pages reconstruct large UTF-8 files and single enormous lines exactly", () => {
  for (const text of ["first\n" + "😀界".repeat(50000) + "\nlast", "short\n".repeat(10000)]) {
    const bytes = Buffer.from(text); let cursor = 0, output = "", hash: string | undefined;
    do {
      const p = readPage(bytes, { byteOffset: cursor, ...(hash ? { expectedHash: hash } : {}) });
      assert.ok(p.returnedBytes <= READ_PAGE_BYTES); assert.ok(!p.text.includes("�"));
      output += p.text; hash = p.sourceHash;
      if (p.nextByteOffset === null) break;
      assert.ok(p.nextByteOffset > cursor); cursor = p.nextByteOffset;
    } while (true);
    assert.equal(output, text);
  }
});
test("line ranges, cursor validation and changed-file guard", () => {
  assert.equal(readPage(Buffer.from("l0\nl1\nl2\nl3"), { offset: 1, limit: 2 }).text, "l1\nl2");
  const old = readPage(Buffer.from("old"), {});
  assert.throws(() => readPage(Buffer.from("new"), { expectedHash: old.sourceHash }), /changed/);
  assert.throws(() => readPage(Buffer.from("😀"), { byteOffset: 1 }), /boundary/);
  assert.throws(() => readPage(Buffer.from("x"), { offset: -1 }), /integer/);
  assert.equal(readPage(Buffer.from("x"), { limit: 0 }).returnedBytes, 0);
});
test("compaction does not start an overlapping background summary and retains shrink headroom", () => {
  for (const [context, output] of [[65536,16384],[32768,8192],[8192,1024]]) {
    const p = workerCompactionPolicy(context!,output!);
    assert.equal(p.backgroundTokens,0); assert.ok(p.reserveTokens >= output!);
    assert.ok(p.keepRecentTokens + .8*p.reserveTokens < context!-p.reserveTokens);
  }
});
test("read loop facts survive persistence and compaction, deduplicate replay, and reset only on successful edits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdm-memory-test-"));
  let store = await MetadataStore.open(join(dir,"test.sqlite"));
  try {
    let m: WorkMemory | null = null;
    for(let i=0;i<24;i++) m=rememberTool(m, String(i), "read", {path:"src/large.ts"}, {details:{sourceHash:"same",byteOffset:0}}, i);
    assert.equal(m!.loop,true); const replay=rememberTool(m,"23","read",{path:"src/large.ts"},{},25);
    assert.deepEqual(replay,m);
    store.setControl("work-memory:a",m);store.close();store=await MetadataStore.open(join(dir,"test.sqlite"));
    m=store.getControl<WorkMemory>("work-memory:a");
    assert.match(workMemoryMessage(m!),/Repeated unchanged reads/);
    assert.equal(rememberTool(m,"failed","edit",{path:"src/large.ts"},{isError:true},27).loop,true);
    const edited=rememberTool(m,"edited","edit",{path:"src/large.ts"},{},28);
    assert.equal(edited.loop,false);assert.equal(edited.readsSinceEdit,0);assert.equal(edited.lastEditAt,28);
  } finally { store.close();await rm(dir,{recursive:true,force:true}); }
});
test("distinct pages are not reported as repeated unchanged reads", () => {
  let m: WorkMemory | null = null;
  for(let i=0;i<25;i++) m=rememberTool(m,String(i),"read",{path:"long"},{details:{sourceHash:"same",byteOffset:i*100}},i);
  assert.equal(m!.loop,false);assert.equal(m!.reads.length,12);
});
