import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { z } from "zod";

const maximumLineBytes = 32 * 1024 * 1024;
const applicationCounts = {
  account_profile: "profile", record: "records", conversation: "conversations",
  projection: "projections", artifact: "artifacts", upload: "uploads",
  upload_usage: "uploadUsage", budget_reservation: "reservations",
  budget_correction: "corrections", usage: "usage",
} as const;
const recordCounts = { record: "records" } as const;
const sourceCounts = { source_event: "sourceEvents" } as const;
const footer = z.object({ counts: z.record(z.string(), z.number().int().nonnegative()),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/), nextIndex: z.number().int().nonnegative().optional(),
  complete: z.boolean().optional() }).strict();

/** Verify the exact published bytes and section counts without loading the export into memory. */
export async function verifyExport(path: string) {
  const digest = createHash("sha256");
  let pending = Buffer.alloc(0), manifest: Record<string, unknown> | undefined;
  let expected: Record<string, string> | undefined;
  let counts: Record<string, number> = {}, ended = false, lineNumber = 0;
  let lastSourceIndex = -1;
  function accept(raw: Buffer) {
    lineNumber++;
    if (ended) throw new Error("Export contains data after its footer.");
    let row: { type?: unknown; value?: unknown };
    try { row = JSON.parse(raw.subarray(0, raw.length - 1).toString("utf8")); }
    catch { throw new Error(`Export line ${lineNumber} is invalid JSON.`); }
    if (!row || typeof row !== "object" || typeof row.type !== "string") throw new Error(`Export line ${lineNumber} has no type.`);
    if (lineNumber === 1) {
      if (row.type !== "manifest" || !row.value || typeof row.value !== "object") throw new Error("Export has no manifest.");
      manifest = row.value as Record<string, unknown>;
      expected = manifest.format === "ai-app-jumpstart-source-events-v1" ? sourceCounts
        : manifest.format === "ai-app-jumpstart-visible-data-v5" && manifest.mode === "application" ? applicationCounts
        : manifest.format === "ai-app-jumpstart-visible-data-v5" && manifest.mode === "records" ? recordCounts : undefined;
      if (!expected) throw new Error("Export format or mode is unsupported.");
      counts = Object.fromEntries(Object.values(expected === recordCounts ? applicationCounts : expected).map(key => [key, 0]));
    } else if (row.type === "end") {
      const result = footer.parse(row.value);
      if (Object.keys(result.counts).length !== Object.keys(counts).length ||
        Object.entries(counts).some(([key, count]) => result.counts[key] !== count)) throw new Error("Export section counts do not match its footer.");
      if (result.contentSha256 !== digest.digest("hex")) throw new Error("Export content checksum does not match.");
      if (manifest?.format === "ai-app-jumpstart-source-events-v1" &&
        (result.complete !== true || result.nextIndex === undefined || result.nextIndex <= lastSourceIndex)) throw new Error("Source export footer is incomplete.");
      ended = true;
      return;
    } else {
      const key = expected?.[row.type];
      if (!key) throw new Error(`Export line ${lineNumber} has an unexpected type.`);
      counts[key]++;
      if (row.type === "source_event") {
        const index = (row.value as { sourceIndex?: unknown } | null)?.sourceIndex;
        if (!Number.isSafeInteger(index) || (index as number) <= lastSourceIndex) throw new Error("Source event indexes are not in order.");
        lastSourceIndex = index as number;
      }
    }
    digest.update(raw);
  }
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    pending = Buffer.concat([pending, bytes]);
    let newline: number;
    while ((newline = pending.indexOf(10)) !== -1) {
      if (newline + 1 > maximumLineBytes) throw new Error("Export line exceeds the verification limit.");
      accept(pending.subarray(0, newline + 1));
      pending = pending.subarray(newline + 1);
    }
    if (pending.length > maximumLineBytes) throw new Error("Export line exceeds the verification limit.");
  }
  if (pending.length) throw new Error("Export ends with an incomplete line.");
  if (!ended || !manifest) throw new Error("Export has no complete footer.");
  return { format: manifest.format, mode: manifest.mode ?? "source-events", counts };
}
