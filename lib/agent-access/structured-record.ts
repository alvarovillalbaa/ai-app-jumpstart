import { z } from "zod";

/** A fixed demonstration schema. The caller cannot provide its own model schema. */
export const structuredRecordSchema = {
  type: "object",
  properties: {
    title: { type: "string", maxLength: 120 },
    summary: { type: "string", maxLength: 2000 },
    items: { type: "array", items: { type: "string", maxLength: 240 }, maxItems: 8 },
  },
  required: ["title", "summary", "items"],
  additionalProperties: false,
} as const;

export const structuredRecord = z.object({
  title: z.string().max(120),
  summary: z.string().max(2000),
  items: z.array(z.string().max(240)).max(8),
}).strict();

/** A reviewed result saved through the owner-scoped, versioned record API. */
export const structuredDraft = z.object({
  kind: z.literal("structured-draft"),schemaVersion: z.literal(1),
  sourceOperationId: z.uuid(),value: structuredRecord,
}).strict();
export function storedStructuredDraft(content: string) {
  try { return structuredDraft.safeParse(JSON.parse(content)).data ?? null; }
  catch { return null; }
}

export const structuredRecordRequest = z.object({
  message: z.string().trim().min(1).max(32_000),
  operationId: z.uuid(),
  mode: z.literal("structured-record"),
}).strict();

export const structuredRecordWire = z.object({
  message: z.string().min(1).max(32_000),
  operationId: z.uuid(),
  outputSchema: z.object({
    type: z.literal("object"),
    properties: z.object({
      title: z.object({ type: z.literal("string"),maxLength: z.literal(120) }).strict(),
      summary: z.object({ type: z.literal("string"),maxLength: z.literal(2000) }).strict(),
      items: z.object({ type: z.literal("array"),items: z.object({ type: z.literal("string"),maxLength: z.literal(240) }).strict(),maxItems: z.literal(8) }).strict(),
    }).strict(),
    required: z.tuple([z.literal("title"),z.literal("summary"),z.literal("items")]),
    additionalProperties: z.literal(false),
  }).strict(),
}).strict();
