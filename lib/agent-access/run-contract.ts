import { z } from "zod";
import { projectionEventId, projectionSourceIndex, type ProjectionEntry } from "./projection-contract";

const state = z.enum(["running","completed","failed","cancelled"]);
const fact = z.object({ kind: z.enum(["run","model"]),at: z.iso.datetime(),ordinal: z.number().int().positive(),sourceIndex: projectionSourceIndex.nullable(),
  state: state.nullable(),code: z.string().max(100).nullable(),model: z.string().max(200).nullable() }).strict();
const summary = z.object({ firstIndex: z.number().int().positive(),startedAt: z.iso.datetime().nullable(),models: z.array(z.string().max(200)),
  unindexedFacts: z.number().int().nonnegative(),lastFactSourceIndex: projectionSourceIndex.nullable(),
  boundaryCount: z.number().int().nonnegative(),unindexedBoundaries: z.number().int().nonnegative(),
  latest: z.object({ state,at: z.iso.datetime(),sourceIndex: projectionSourceIndex,code: z.string().max(100).nullable() }).strict().nullable() }).strict();
export const runCache = z.object({ schemaVersion: z.literal(1),facts: z.record(projectionEventId,fact),summary }).strict();
export const runOptions = z.object({ limit: z.number().int().min(1).max(50).default(20),after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() }).strict();
export type RunOptions = z.input<typeof runOptions>;
export const runRepairOptions = z.object({ after: z.number().int().nonnegative().default(0),limit: z.number().int().min(1).max(250).default(100) }).strict();
export const runRepairResult = z.object({ processed: z.number().int().nonnegative(),nextIndex: z.number().int().nonnegative(),complete: z.boolean() }).strict();
export const runView = z.object({ turnId: z.string().min(1).max(512),firstIndex: summary.shape.firstIndex,
  state: z.enum(["unverified","running","completed","failed","cancelled"]),startedAt: summary.shape.startedAt,
  lastBoundaryAt: z.iso.datetime().nullable(),lastSourceIndex: projectionSourceIndex.nullable(),code: z.string().max(100).nullable(),
  boundarySourceIndex: projectionSourceIndex.nullable(),unindexedFacts: summary.shape.unindexedFacts,
  models: summary.shape.models,boundaryCount: summary.shape.boundaryCount,unindexedBoundaries: summary.shape.unindexedBoundaries,
  coverage: z.object({ checkpoint: projectionSourceIndex,indexComplete: z.boolean() }).strict() }).strict();
export const runPage = z.object({ schemaVersion: z.literal(1),source: z.literal("eve-run-boundaries"),items: z.array(runView),nextCursor: z.number().int().positive().nullable() }).strict();

/** Private event identities prevent retries/annotations from double counting. */
export function materializeRun(existing: string | null,entry: ProjectionEntry,ordinal: number,sourceIndex?: number | null): string | null {
  if (entry.payload.kind !== "run" && entry.payload.kind !== "model") return null;
  const facts = existing === null ? {} : runCache.parse(JSON.parse(existing)).facts;
  facts[entry.eventId] = runFact(entry,ordinal,sourceIndex);
  return cacheFromFacts(facts);
}
export function runFact(entry: ProjectionEntry,ordinal: number,sourceIndex?: number | null) {
  if (entry.payload.kind !== "run" && entry.payload.kind !== "model") throw new Error("Unsupported run fact.");
  return fact.parse({ kind: entry.payload.kind,at: entry.at,ordinal,sourceIndex: sourceIndex ?? null,
    state: entry.payload.kind === "run" ? entry.payload.state : null,
    code: entry.payload.kind === "run" ? entry.payload.code ?? null : null,
    model: entry.payload.kind === "model" ? entry.payload.modelId : null });
}
export function cacheFromFacts(facts: z.infer<typeof runCache>["facts"]): string {
  const values = Object.values(facts),boundaries = values.filter(value => value.kind === "run"),
    latest = boundaries.filter(value => value.sourceIndex !== null).sort((a,b) => b.sourceIndex!-a.sourceIndex!)[0];
  if (!values.length || values.length > 4096) throw new Error("Run materialization exceeds its fact limit.");
  const body = JSON.stringify(runCache.parse({ schemaVersion: 1,facts,summary: {
    firstIndex: Math.min(...values.map(value => value.ordinal)),
    startedAt: boundaries.filter(value => value.state === "running").map(value => value.at).sort()[0] ?? null,
    models: [...new Set(values.flatMap(value => value.model === null ? [] : [value.model]))].sort(),
    boundaryCount: boundaries.length,unindexedBoundaries: boundaries.filter(value => value.sourceIndex === null).length,
    unindexedFacts: values.filter(value => value.sourceIndex === null).length,
    lastFactSourceIndex: values.some(value => value.sourceIndex !== null) ? Math.max(...values.flatMap(value => value.sourceIndex === null ? [] : [value.sourceIndex])) : null,
    latest: latest ? { state: latest.state,at: latest.at,sourceIndex: latest.sourceIndex,code: latest.code } : null,
  } }));
  if (new TextEncoder().encode(body).byteLength > 524_288) throw new Error("Run materialization exceeds its size limit.");
  return body;
}
export function pageOfRuns(rows: { turnId: string;payload: string;checkpoint: number;indexComplete: boolean }[],limit: number) {
  const items = rows.slice(0,limit).map(row => {
    const { summary: s } = runCache.parse(JSON.parse(row.payload));
    const verified = row.indexComplete && s.unindexedFacts === 0 && s.latest !== null && s.lastFactSourceIndex !== null && s.lastFactSourceIndex < row.checkpoint
      && (s.latest.state === "running" || s.latest.sourceIndex === s.lastFactSourceIndex);
    return runView.parse({ turnId: row.turnId,firstIndex: s.firstIndex,state: verified ? s.latest!.state : "unverified",startedAt: s.startedAt,
      lastBoundaryAt: s.latest?.at ?? null,lastSourceIndex: s.lastFactSourceIndex,boundarySourceIndex: s.latest?.sourceIndex ?? null,code: verified ? s.latest!.code : null,
      models: [...s.models].sort(),boundaryCount: s.boundaryCount,unindexedBoundaries: s.unindexedBoundaries,unindexedFacts: s.unindexedFacts,coverage: { checkpoint: row.checkpoint,indexComplete: row.indexComplete } });
  });
  return runPage.parse({ schemaVersion: 1,source: "eve-run-boundaries",items,nextCursor: rows.length > limit ? items.at(-1)!.firstIndex : null });
}
