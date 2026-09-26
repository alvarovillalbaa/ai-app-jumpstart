import { createHash } from "node:crypto";
import type { RecordInput,RecordCreateReceipt } from "./contract";

/** Hash the validated input in a fixed order; receipts retain no second content copy. */
export function recordCreationHash(input: RecordInput) {
  return createHash("sha256").update(JSON.stringify({ title: input.title,content: input.content })).digest("hex");
}
export function originalCreatedRecord(receipt: RecordCreateReceipt,input: RecordInput) {
  return { ...input,id: receipt.id,revision: 1,createdAt: receipt.createdAt,updatedAt: receipt.createdAt };
}
