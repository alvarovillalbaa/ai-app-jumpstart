#!/usr/bin/env node
import { readFile,stat } from "node:fs/promises";
import { basename } from "node:path";
import { historyOptions, historyPatch, operationId } from "../lib/agent-access/contract";
import { projectionOptions } from "../lib/agent-access/projection-contract";
import { artifactOptions } from "../lib/agent-access/artifact-contract";
import { ledgerQueryOptions } from "../lib/budgets/contract";
import { recordId, recordInput } from "../lib/data/contract";
import { exportApplication } from "./export-application";
import { z } from "zod";
import { MAX_API_UPLOAD_BYTES } from "../lib/uploads/validation";
import { uploadId } from "../lib/uploads/schema";

const seedPage = z.object({
  items: z.array(recordInput.extend({ id: recordId }).passthrough()),
  nextCursor: recordId.nullable(),
});

export async function run(args: string[], env: Record<string, string | undefined> = process.env, request = fetch): Promise<unknown> {
  const [command, ...rest] = args;
  if (!command || command === "help") return {
    records: "npm run app -- <list [cursor] | get ID | create JSON_FILE | update ID JSON_FILE | delete ID REVISION>",
    seed: "npm run app -- seed [--allow-remote] (two idempotent, owner-scoped example records)",
    conversations: "npm run app -- conversations <list [--archived] [--limit N] [--cursor CURSOR] | get OPERATION_UUID | events OPERATION_UUID [AFTER_INGESTION_INDEX] | update OPERATION_UUID JSON_FILE>",
    artifacts: "npm run app -- artifacts <list [--limit N] [--cursor CURSOR] | get ARTIFACT_UUID | delete ARTIFACT_UUID>",
    uploads: "npm run app -- uploads <list | get UPLOAD_UUID | put FILE | delete UPLOAD_UUID> (private quarantine; no download)",
    account: "npm run app -- account profile (selected fields; current registered-user token required)",
    usage: "npm run app -- usage [reservations|corrections [--limit N] [--cursor CURSOR]] (verified user token required)",
    export: "npm run app -- export <records | application> OUTPUT.ndjson (private, no-clobber; application includes upload metadata, never bytes)",
    environment: "APP_API_URL (default http://localhost:3000), APP_API_TOKEN (server-issued credential)",
    note: "Record files contain title/content and, for update, revision. Conversation updates contain revision plus title and/or archived. Uploads require uploads:read/write scopes or a registered user and an explicitly configured private object backend; quarantined bytes cannot be downloaded. Output is JSON. Errors exit nonzero. Writes are never automatically retried.",
  };
  const origin = new URL(env.APP_API_URL ?? "http://localhost:3000");
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash || !["http:", "https:"].includes(origin.protocol)) throw new Error("APP_API_URL must be an HTTP(S) origin without credentials, path, query or fragment.");
  if (origin.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) throw new Error("Use HTTPS for remote servers.");
  if (!env.APP_API_TOKEN) throw new Error("Set APP_API_TOKEN.");
  const call = async (path: string, method = "GET", body?: string | Buffer, extraHeaders: Record<string,string> = {}) => {
    const response = await request(new URL(path, origin), {
      method, body: typeof body === "string" ? body : body ? new Blob([Uint8Array.from(body)]) : undefined,
      redirect: "error", signal: AbortSignal.timeout(body && typeof body !== "string" ? 30_000 : 15_000),
      headers: { authorization: `Bearer ${env.APP_API_TOKEN}`, "content-type": body && typeof body !== "string" ? "application/octet-stream" : "application/json",
        ...extraHeaders,
        ...(env.VERCEL_AUTOMATION_BYPASS_SECRET ? { "x-vercel-protection-bypass": env.VERCEL_AUTOMATION_BYPASS_SECRET } : {}) },
    });
    if (!response.ok) {
      // Display only the public application error; do not echo a proxy HTML page.
      const result = await response.json().catch(() => null);
      throw new Error(`HTTP ${response.status}: ${result?.error?.code ?? "request_failed"}`);
    }
    return response.status === 204 ? { deleted: true } : response.json();
  };
  if (command === "seed" && (rest.length === 0 || (rest.length === 1 && rest[0] === "--allow-remote"))) {
    const local = origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
    if (!local && rest[0] !== "--allow-remote") throw new Error("Refusing to seed a remote application without --allow-remote.");
    const fixtures = z.array(recordInput).min(1).max(10).parse(JSON.parse(await readFile(new URL("./fixtures/records.json", import.meta.url), "utf8")));
    if (new Set(fixtures.map(row => row.title)).size !== fixtures.length) throw new Error("Duplicate seed titles.");
    const wanted = new Set(fixtures.map(row => row.title));
    const found = new Map<string, string>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let pages = 0; pages < 100; pages++) {
      const query = new URLSearchParams({ limit: "100", ...(cursor ? { after: cursor } : {}) });
      const result = seedPage.parse(await call(`/api/v1/records?${query}`));
      for (const row of result.items) if (wanted.has(row.title)) {
        if (found.has(row.title)) throw new Error(`Multiple records already use seed title: ${row.title}`);
        found.set(row.title, row.content);
      }
      if (!result.nextCursor) { cursor = null; break; }
      if (seenCursors.has(result.nextCursor)) throw new Error("Record pagination repeated a cursor.");
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    if (cursor) throw new Error("Seed preflight exceeded 10,000 records; no records were created.");
    for (const row of fixtures) if (found.has(row.title) && found.get(row.title) !== row.content) {
      throw new Error(`Seed title exists with different content: ${row.title}`);
    }
    let created = 0;
    for (const row of fixtures) if (!found.has(row.title)) {
      await call("/api/v1/records", "POST", JSON.stringify(row));
      created++;
    }
    return { created, existing: fixtures.length - created, titles: fixtures.map(row => row.title) };
  }
  if (command === "export" && rest.length === 2 && (rest[0] === "records" || rest[0] === "application")) {
    return exportApplication(rest[0], rest[1], path => call(path));
  }
  if (command === "account" && rest.length === 1 && rest[0] === "profile") return call("/api/v1/account/profile");
  if (command === "usage" && (rest[0] === "reservations" || rest[0] === "corrections")) {
    const input: Record<string,unknown> = {},options = rest.slice(1);
    for (let i=0;i<options.length;i++) {
      const flag = options[i];
      if ((flag !== "--limit" && flag !== "--cursor") || options[i+1] === undefined || Object.hasOwn(input,flag.slice(2))) throw new Error("Invalid usage history options.");
      input[flag.slice(2)] = flag === "--limit" ? Number(options[++i]) : options[++i];
    }
    const checked = ledgerQueryOptions.safeParse(input);
    if (!checked.success) throw new Error("Invalid usage history options.");
    return call(`/api/v1/usage/${rest[0]}?${new URLSearchParams({ limit: String(checked.data.limit),...(checked.data.cursor ? { cursor: checked.data.cursor } : {}) })}`);
  }
  if (command === "uploads") {
    const [action,...options] = rest;
    if (action === "list" && options.length === 0) return call("/api/v1/uploads");
    if ((action === "get" || action === "delete") && options.length === 1) {
      const checked = uploadId.safeParse(options[0]);
      if (!checked.success) throw new Error("Provide an upload UUID.");
      return call(`/api/v1/uploads/${checked.data}`,action === "delete" ? "DELETE" : "GET");
    }
    if (action === "put" && options.length === 1) {
      const file = options[0],name = basename(file),extension = name.split(".").at(-1)?.toLowerCase();
      const mediaType = extension === "txt" ? "text/plain" : extension === "png" ? "image/png" :
        extension === "jpg" || extension === "jpeg" ? "image/jpeg" : extension === "pdf" ? "application/pdf" : undefined;
      if (!mediaType) throw new Error("Use a .txt, .png, .jpg, .jpeg or .pdf file.");
      const info = await stat(file);
      if (!info.isFile() || info.size < 1 || info.size > MAX_API_UPLOAD_BYTES) throw new Error("Upload file must be 1 byte to 4 MiB.");
      return call("/api/v1/uploads","POST",await readFile(file),{
        "x-upload-name": encodeURIComponent(name),"x-upload-media-type": mediaType,
      });
    }
    throw new Error("Invalid upload command. Run npm run app -- help.");
  }
  let path = "/api/v1/records", method = "GET", body: string | undefined;
  const id = (value: string | undefined) => {
    if (!value || !/^[a-f0-9-]{36}$/i.test(value)) throw new Error("Provide a record UUID.");
    return value;
  };
  if (command === "usage" && rest.length === 0) path = "/api/v1/usage";
  else if (command === "conversations") {
    const [action,...options] = rest;
    path = "/api/v1/conversations";
    if (action === "events" && options.length >= 1 && options.length <= 2) {
      const id = operationId.safeParse(options[0]), query = projectionOptions.safeParse(options[1] ? { after: Number(options[1]) } : {});
      if (!id.success || !query.success) throw new Error("Provide a conversation operation UUID and optional projection ingestion cursor.");
      path += `/${id.data}/events${query.data.after ? `?after=${encodeURIComponent(query.data.after)}` : ""}`;
    } else if (action === "list") {
      const input: Record<string,unknown> = {}, seen = new Set<string>();
      for (let i = 0; i < options.length; i++) {
        const flag = options[i];
        if (seen.has(flag)) throw new Error("Duplicate conversation list option.");
        seen.add(flag);
        if (flag === "--archived") input.archived = true;
        else if ((flag === "--limit" || flag === "--cursor") && options[i+1] !== undefined) {
          const value = options[++i]; input[flag.slice(2)] = flag === "--limit" ? Number(value) : value;
        } else throw new Error("Invalid conversation list options.");
      }
      const checked = historyOptions.safeParse(input);
      if (!checked.success) throw new Error("Invalid conversation list options.");
      const query = new URLSearchParams({ archived: String(checked.data.archived),limit: String(checked.data.limit),...(checked.data.cursor ? { cursor: checked.data.cursor } : {}) });
      path += `?${query}`;
    } else if ((action === "get" && options.length === 1) || (action === "update" && options.length === 2)) {
      const checked = operationId.safeParse(options[0]);
      if (!checked.success) throw new Error("Provide a conversation operation UUID.");
      path += `/${checked.data}`;
      if (action === "get") path += "/metadata";
      else {
        const patch = historyPatch.safeParse(JSON.parse(await readFile(options[1],"utf8")));
        if (!patch.success) throw new Error("Invalid conversation update. Supply revision and title and/or archived.");
        method = "PATCH"; body = JSON.stringify(patch.data);
      }
    } else throw new Error("Invalid conversation command. Run npm run app -- help.");
  }
  else if (command === "artifacts") {
    const [action,...options] = rest;
    path = "/api/v1/artifacts";
    if ((action === "get" || action === "delete") && options.length === 1) {
      path += `/${id(options[0])}`;
      if (action === "delete") method = "DELETE";
    }
    else if (action === "list") {
      const input: Record<string,unknown> = {};
      for (let i=0;i<options.length;i++) {
        const flag = options[i];
        if ((flag !== "--limit" && flag !== "--cursor") || options[i+1] === undefined || Object.hasOwn(input,flag.slice(2))) throw new Error("Invalid artifact list options.");
        input[flag.slice(2)] = flag === "--limit" ? Number(options[++i]) : options[++i];
      }
      const checked = artifactOptions.safeParse(input);
      if (!checked.success) throw new Error("Invalid artifact list options.");
      path += `?${new URLSearchParams({ limit: String(checked.data.limit),...(checked.data.cursor ? { cursor: checked.data.cursor } : {}) })}`;
    } else throw new Error("Invalid artifact command. Run npm run app -- help.");
  }
  else if (command === "list" && rest.length <= 1) { if (rest[0]) path += `?after=${encodeURIComponent(id(rest[0]))}`; }
  else if (command === "get" && rest.length === 1) path += `/${id(rest[0])}`;
  else if (command === "create" && rest.length === 1) { method = "POST"; body = await readFile(rest[0], "utf8"); }
  else if (command === "update" && rest.length === 2) { method = "PATCH"; path += `/${id(rest[0])}`; body = await readFile(rest[1], "utf8"); }
  else if (command === "delete" && rest.length === 2 && /^[1-9]\d*$/.test(rest[1])) { method = "DELETE"; path += `/${id(rest[0])}?revision=${rest[1]}`; }
  else throw new Error("Invalid command or arguments. Run npm run app -- help.");
  if (body) JSON.parse(body);
  return call(path, method, body);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  run(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : "Command failed" }));
    process.exitCode = 1;
  });
}
