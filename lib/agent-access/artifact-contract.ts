import { z } from "zod";

/** Plain text only: no active HTML/SVG or client-selected storage path. */
export const artifactInput = z.object({
  title: z.string().trim().min(1).max(120).refine(value => !/[\u0000-\u001f\u007f]/u.test(value) && !hasUnpairedSurrogate(value),"Use a plain-text title without control characters."),
  content: z.string().min(1).max(32_000).refine(value => !value.includes("\u0000") && !hasUnpairedSurrogate(value),"Use well-formed text without null bytes."),
}).strict();
function hasUnpairedSurrogate(value: string) { return Array.from(value).some(char => { const code = char.codePointAt(0)!;return code >= 0xd800 && code <= 0xdfff; }); }
export type ArtifactInput = z.infer<typeof artifactInput>;
export const artifactCallId = z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/);
export const artifact = artifactInput.extend({
  id: z.uuid(),operationId: z.uuid(),sourceSessionId: z.string().min(1).max(512),sourceCallId: artifactCallId,
  mediaType: z.literal("text/plain"),createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type Artifact = z.infer<typeof artifact>;
export const artifactSaveResult = z.discriminatedUnion("status",[
  z.object({ status: z.literal("created"),artifact }).strict(),
  z.object({ status: z.literal("existing"),artifact }).strict(),
  z.object({ status: z.literal("conflict") }).strict(),
  z.object({ status: z.literal("unavailable") }).strict(),
]);
export type ArtifactSaveResult = z.infer<typeof artifactSaveResult>;
export const artifactCursor = z.string().regex(/^[0-9]{1,16}\.[a-f0-9-]{36}$/).refine(value => {
  const [time,id] = value.split(".");return Number.isSafeInteger(Number(time)) && z.uuid().safeParse(id).success;
});
export const artifactOptions = z.object({ limit: z.number().int().min(1).max(50).default(20),cursor: artifactCursor.optional() }).strict();
export type ArtifactOptions = z.input<typeof artifactOptions>;
export const artifactPage = z.object({ items: z.array(artifact),nextCursor: artifactCursor.nullable() }).strict();
export function artifactFromRow(value: unknown): Artifact {
  const row = z.object({ id: z.uuid(),operation_id: z.uuid(),session_id: z.string(),call_id: artifactCallId,
    title: z.string(),content: z.string(),created_at: z.coerce.number() }).parse(value);
  return artifact.parse({ id: row.id,operationId: row.operation_id,sourceSessionId: row.session_id,
    sourceCallId: row.call_id,title: row.title,content: row.content,mediaType: "text/plain",createdAt: row.created_at });
}
export function pageOfArtifacts(rows: Artifact[],limit: number) {
  const items = rows.slice(0,limit),last = items.at(-1);
  return artifactPage.parse({ items,nextCursor: rows.length > limit && last ? `${last.createdAt}.${last.id}` : null });
}
