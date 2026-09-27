import { z } from "zod";
import type { Owner } from "../data/contract";

export const limitOwner = z.object({ tenant: z.string().min(1).max(200),subject: z.string().min(1).max(200) }).strict();
export const requestLimit = z.number().int().min(1).max(10000);
export const limitInput = limitOwner.extend({ limit: requestLimit }).strict();
export const limitCommand = z.discriminatedUnion("operation",[
  limitInput.extend({ operation: z.literal("limit.claim") }).strict(),
  z.object({ operation: z.literal("limit.health") }).strict(),
]);
export const limitResult = z.object({ allowed: z.boolean(),remaining: z.number().int().min(0).max(10000),
  resetAt: z.iso.datetime(),retryAfterSeconds: z.number().int().min(0).max(60) }).strict()
  .refine(value => value.allowed ? value.retryAfterSeconds === 0 : value.remaining === 0 && value.retryAfterSeconds >= 1);
export type LimitResult = z.infer<typeof limitResult>;
export interface RequestLimitStore {
  claim(owner: Owner,limit: number): Promise<LimitResult>;
  health(): Promise<void>;
  close(): Promise<void>;
}
export function windowResult(allowed: boolean,count: number,bucket: number,limit: number,now: number): LimitResult {
  return limitResult.parse({ allowed,remaining: allowed ? Math.max(0,limit-count) : 0,resetAt: new Date(bucket+60000).toISOString(),
    retryAfterSeconds: allowed ? 0 : Math.max(1,Math.min(60,Math.ceil((bucket+60000-now)/1000))) });
}
