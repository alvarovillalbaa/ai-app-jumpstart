import { z } from "zod";

export const projectionEventId = z.string().regex(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
export const projectionPayload = z.discriminatedUnion("kind",[
  z.object({ kind: z.literal("run"),state: z.enum(["running","completed","failed","cancelled"]),code: z.string().max(100).optional() }).strict(),
  z.object({ kind: z.literal("message"),role: z.enum(["user","assistant"]),parts: z.array(z.discriminatedUnion("type",[
    z.object({ type: z.literal("text"),text: z.string() }).strict(),
    z.object({ type: z.literal("file"),filename: z.string().optional(),mediaType: z.string(),size: z.number().nonnegative().optional() }).strict(),
  ])),finishReason: z.string().max(100).optional() }).strict(),
  z.object({ kind: z.literal("tool"),phase: z.enum(["requested","result"]),value: z.json() }).strict(),
  z.object({ kind: z.literal("result"),value: z.json() }).strict(),
  z.object({ kind: z.literal("context"),action: z.enum(["cleared","compacted"]) }).strict(),
  z.object({ kind: z.literal("omitted"),eventType: z.string().max(100),reason: z.literal("size_limit") }).strict(),
]);
export const projectionEntry = z.object({ schemaVersion: z.literal(1),eventId: projectionEventId,at: z.iso.datetime(),turnId: z.string().min(1).max(512),sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),stepIndex: z.number().int().nonnegative().optional(),payload: projectionPayload }).strict()
  .refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 49_152,"Projection exceeds 48 KiB.");
export type ProjectionEntry = z.infer<typeof projectionEntry>;
export const projectionOptions = z.object({ limit: z.number().int().min(1).max(50).default(20),after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() }).strict();
export type ProjectionOptions = z.input<typeof projectionOptions>;
export const projectionPage = z.object({ schemaVersion: z.literal(1),source: z.literal("eve-stream"),items: z.array(z.object({ ...projectionEntry.shape,ingestionIndex: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict()),nextCursor: z.number().int().positive().nullable() }).strict();
export const projectionOutcome = z.enum(["inserted","duplicate","conflict","unavailable"]);
export function pageOfProjections(rows: { entry: unknown; index: number }[], limit: number) {
  const items = rows.slice(0,limit).map(row => ({ ...projectionEntry.parse(row.entry),ingestionIndex: row.index }));
  return projectionPage.parse({ schemaVersion: 1,source: "eve-stream",items,nextCursor: rows.length > limit ? items.at(-1)?.ingestionIndex : null });
}
