import { type CheckpointOptions, type CheckpointRef } from "./checkpoint-common.js";
/**
 * Create a checkpoint of `root` under `privateDir/<id>`. Refuses to overwrite an
 * existing checkpoint (O_EXCL). Returns a manifest ref with honest
 * complete/reasons — an incomplete capture is never reported as full.
 */
export declare function createCheckpoint(root: string, privateDir: string, id: string, options?: CheckpointOptions): Promise<CheckpointRef>;
//# sourceMappingURL=checkpoint-capture.d.ts.map