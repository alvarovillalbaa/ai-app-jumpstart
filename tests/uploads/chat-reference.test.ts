import { expect,it } from "vitest";
import { encodeReviewedUploadMessage,parseReviewedUploadMessage } from "../../lib/uploads/chat-reference";
import { creationBody,requestHash } from "../../lib/agent-access/signing";

const upload = { id: "cba8c2d0-e3a2-4395-bc82-392d59c9b6e8",name: "Notes.txt",sha256: "a".repeat(64),reviewRevision: 1 };
it("preserves the exact request and reference inside the signed plain-text transport",() => {
  const text = "Summarize café\nKeep these lines.",message = encodeReviewedUploadMessage(text,upload);
  expect(parseReviewedUploadMessage(message)).toEqual({ format: "jumpstart.reviewed-upload-message.v1",text,upload });
  const body = creationBody({ message,operationId: upload.id }).body;
  expect(JSON.parse(body).message).toBe(message);
  expect(requestHash(body)).not.toBe(requestHash(creationBody({ message: encodeReviewedUploadMessage(text,{ ...upload,reviewRevision: 2 }),operationId: upload.id }).body));
});
it("leaves malformed, URL-bearing and unknown envelopes as ordinary text",() => {
  const message = JSON.parse(encodeReviewedUploadMessage("Read this",upload));
  for (const candidate of ["ordinary text","{",JSON.stringify({ ...message,format: "unknown" }),JSON.stringify({ ...message,upload: { ...upload,url: "https://foreign.test/file" } }),
    JSON.stringify({ ...message,upload: { ...upload,reviewRevision: 0 } }),"{"+"x".repeat(32000)]) expect(parseReviewedUploadMessage(candidate)).toBeNull();
});
it("counts reference overhead toward the existing message limit without truncation",() => {
  expect(() => encodeReviewedUploadMessage("x".repeat(32000),upload)).toThrow("too long");
  expect(parseReviewedUploadMessage(encodeReviewedUploadMessage("x".repeat(31000),upload))?.text).toHaveLength(31000);
});
