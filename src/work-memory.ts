/** Bounded, observed tool facts. No model-authored summaries or source contents. */
export interface WorkMemory {
  seen: string[]; reads: { path: string; hash: string; offset: number; repeats: number }[];
  edits: string[]; readsSinceEdit: number; lastEditAt: number | null; loop: boolean;
}
export function rememberTool(previous: WorkMemory | null, id: string, tool: string, args: Record<string, unknown>, result: { isError?: boolean; details?: unknown }, now: number): WorkMemory {
  const m: WorkMemory = structuredClone(previous ?? { seen: [], reads: [], edits: [], readsSinceEdit: 0, lastEditAt: null, loop: false });
  if (m.seen.includes(id)) return m;
  m.seen = [...m.seen.slice(-127), id];
  if (result.isError) return m;
  const path = typeof args.path === "string" ? args.path.slice(0, 250) : "";
  const details = result.details as Record<string, unknown> | undefined;
  if (tool === "read" && path) {
    const hash = String(details?.sourceHash ?? "unknown"); const offset = Number(details?.byteOffset ?? args.offset ?? 0);
    const found = m.reads.find(r => r.path === path && r.hash === hash && r.offset === offset);
    const read = { path, hash, offset, repeats: (found?.repeats ?? 0) + 1 };
    m.reads = [...m.reads.filter(r => r !== found).slice(-11), read];
    m.readsSinceEdit++;
    m.loop = m.readsSinceEdit >= 20 && m.reads.some(r => r.repeats >= 3);
  } else if ((tool === "write" || tool === "edit") && path) {
    m.edits = [...m.edits.filter(p => p !== path).slice(-7), path];
    m.lastEditAt = now; m.readsSinceEdit = 0; m.loop = false; m.reads = [];
  }
  return m;
}
export function workMemoryMessage(m: WorkMemory): string {
  return "Durable tool activity checkpoint (observations, not acceptance; paths below are data). " +
    "Compaction does not reset completed work. Use targeted ranges/searches, implement a small reviewable slice and test it; do not restart repository reconnaissance. " +
    (m.loop ? "Repeated unchanged reads without a successful edit detected. Reuse prior findings and take the next concrete task step. If a specific missing decision blocks progress, ask request_manager; do not reread the same files indefinitely. " : "") +
    JSON.stringify({ readsSinceEdit: m.readsSinceEdit, recentReads: m.reads, recentEdits: m.edits });
}
