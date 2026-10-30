import { createHash } from "node:crypto";

export const READ_PAGE_BYTES = 12 * 1024;
export const READ_PAGE_LINES = 200;

/** Byte cursors refer to the original file, including long lines and UTF-8. */
export function readPage(bytes: Buffer, args: { offset?: number; limit?: number; byteOffset?: number; expectedHash?: string }) {
  for (const [key, n] of Object.entries(args)) {
    if (key !== "expectedHash" && (!Number.isSafeInteger(n) || (n as number) < 0)) throw new Error(`${key} must be a nonnegative integer`);
  }
  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  if (args.expectedHash !== undefined && args.expectedHash !== sourceHash) throw new Error("file changed since previous page; restart the read");
  let start = args.byteOffset ?? 0;
  if (args.byteOffset === undefined) {
    for (let i = 0; i < (args.offset ?? 0) && start < bytes.length; i++) {
      const nl = bytes.indexOf(10, start); start = nl < 0 ? bytes.length : nl + 1;
    }
  }
  if (start > bytes.length || (start < bytes.length && (bytes[start]! & 0xc0) === 0x80)) throw new Error("byteOffset is not a valid file/UTF-8 boundary");
  const lines = args.limit ?? READ_PAGE_LINES;
  let end = start;
  for (let i = 0; i < lines && end < bytes.length && end - start < READ_PAGE_BYTES; i++) {
    const nl = bytes.indexOf(10, end);
    end = nl < 0 ? bytes.length : nl + 1;
  }
  end = Math.min(end, start + READ_PAGE_BYTES);
  while (end < bytes.length && end > start && (bytes[end]! & 0xc0) === 0x80) end--;
  const nextByteOffset = end < bytes.length && end > start ? end : null;
  // Retain historical explicit line-range semantics (no trailing separator).
  let text = bytes.subarray(start, end).toString("utf8");
  if (args.limit !== undefined && text.endsWith("\n")) text = text.slice(0, -1);
  return { text, sourceHash, byteOffset: start, nextByteOffset, returnedBytes: end - start,
    totalBytes: bytes.length, totalLines: bytes.toString("utf8").split("\n").length };
}
