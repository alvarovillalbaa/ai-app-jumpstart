import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdtemp, open, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { historyPage } from "../lib/agent-access/contract";
import { artifactPage } from "../lib/agent-access/artifact-contract";
import { projectionPage } from "../lib/agent-access/projection-contract";
import { usageView } from "../lib/budgets/usage";
import { recordId, recordInput } from "../lib/data/contract";
import { uploadPage } from "../lib/uploads/catalog-contract";

type Mode = "records" | "application";
type Call = (path: string) => Promise<unknown>;
const recordPage = z.object({
  items: z.array(recordInput.extend({
    id: recordId, revision: z.number().int().positive(), createdAt: z.string(), updatedAt: z.string(),
  }).strict()),
  nextCursor: recordId.nullable(),
}).strict();

/** Download the app's exposed data without keeping an unbounded response in memory. */
export async function exportApplication(mode: Mode, output: string, call: Call) {
  if (!output || output.includes("\u0000")) throw new Error("Provide an output file path.");
  const destination = resolve(output);
  if (existsSync(destination)) throw new Error("Export destination already exists; choose a new file.");

  // This also proves that application mode has a current registered-user token
  // and enabled account chat before creating a local file.
  const usage = mode === "application" ? usageView.parse(await call("/api/v1/usage")) : null;
  const directory = await mkdtemp(join(dirname(destination), ".jumpstart-export-"));
  const temporary = join(directory, `${randomUUID()}.ndjson`);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  const counts = { records: 0, conversations: 0, projections: 0, artifacts: 0, uploads: 0, uploadUsage: 0, usage: 0 };
  async function write(type: string, value: unknown) {
    if (!file) throw new Error("Export file is unavailable.");
    await file.writeFile(`${JSON.stringify({ type, value })}\n`);
  }
  async function walk<T, C extends string | number>(
    path: (cursor: C | null) => string,
    parse: (value: unknown) => { items: T[]; nextCursor: C | null },
    visit: (item: T) => Promise<void>,
  ) {
    let cursor: C | null = null;
    const seen = new Set<C>();
    for (let pages = 0; pages < 10_000; pages++) {
      const result = parse(await call(path(cursor)));
      for (const item of result.items) await visit(item);
      if (result.nextCursor === null) return;
      if (!result.items.length || seen.has(result.nextCursor)) throw new Error("Export pagination did not advance.");
      seen.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error("Export exceeded 10,000 pages for one collection.");
  }
  try {
    file = await open(temporary, "wx", 0o600);
    await write("manifest", {
      format: "ai-app-jumpstart-visible-data-v2", mode, exportedAt: new Date().toISOString(),
      consistency: "paged-live-reads; concurrent changes may appear or be missed",
      exclusions: mode === "application" ? [
        "Supabase Auth profile, credentials and provider logs",
        "Eve session/model history, workflow checkpoints, sandboxes and traces",
        "Budget reservation, attempt, correction and historical daily ledgers",
        "Deleted artifact tombstones and database backups",
        "Conversation projections are selected events, not a canonical transcript",
        "Private upload object bytes, deleted upload tombstones and derived data",
      ] : ["Conversation, artifact, upload, usage, Auth, Eve and budget data"],
    });
    await walk(
      (cursor: string | null) => `/api/v1/records?${new URLSearchParams({ limit: "100", ...(cursor ? { after: cursor } : {}) })}`,
      value => recordPage.parse(value),
      async item => { await write("record", item); counts.records++; },
    );
    if (mode === "application") {
      for (const archived of [false, true]) {
        await walk(
          (cursor: string | null) => `/api/v1/conversations?${new URLSearchParams({ limit: "50", archived: String(archived), ...(cursor ? { cursor } : {}) })}`,
          value => historyPage.parse(value),
          async item => {
            await write("conversation", item); counts.conversations++;
            await walk(
              (cursor: number | null) => `/api/v1/conversations/${item.operationId}/events?${new URLSearchParams({ limit: "50", ...(cursor ? { after: String(cursor) } : {}) })}`,
              value => projectionPage.parse(value),
              async event => { await write("projection", { operationId: item.operationId, event }); counts.projections++; },
            );
          },
        );
      }
      await walk(
        (cursor: string | null) => `/api/v1/artifacts?${new URLSearchParams({ limit: "50", ...(cursor ? { cursor } : {}) })}`,
        value => artifactPage.parse(value),
        async item => { await write("artifact", item); counts.artifacts++; },
      );
      const uploads = uploadPage.parse(await call("/api/v1/uploads"));
      for (const item of uploads.items) { await write("upload", item); counts.uploads++; }
      await write("upload_usage", uploads.usage); counts.uploadUsage = 1;
      await write("usage", usage); counts.usage = 1;
    }
    await write("end", { counts });
    await file.sync();
    await file.close(); file = undefined;
    // A hard link publishes the complete file atomically and never replaces an
    // existing export, including one created while pages were downloading.
    await link(temporary, destination);
    return { file: destination, mode, counts };
  } finally {
    await file?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
