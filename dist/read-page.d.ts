export declare const READ_PAGE_BYTES: number;
export declare const READ_PAGE_LINES = 200;
/** Byte cursors refer to the original file, including long lines and UTF-8. */
export declare function readPage(bytes: Buffer, args: {
    offset?: number;
    limit?: number;
    byteOffset?: number;
    expectedHash?: string;
}): {
    text: string;
    sourceHash: string;
    byteOffset: number;
    nextByteOffset: number | null;
    returnedBytes: number;
    totalBytes: number;
    totalLines: number;
};
//# sourceMappingURL=read-page.d.ts.map