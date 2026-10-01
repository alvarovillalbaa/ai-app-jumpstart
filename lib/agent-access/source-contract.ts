import { z } from "zod";
import { projectionEntry } from "./projection-contract";

export const sourceEventOptions = z.object({
  startIndex: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-250).default(0),
  limit: z.number().int().min(1).max(50).default(20),
}).strict();

export const sourceEventPage = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("eve-durable-stream"),
  items: z.array(z.object({ ...projectionEntry.shape,sourceIndex: z.number().int().nonnegative() }).strict()),
  scanned: z.number().int().nonnegative(),
  nextIndex: z.number().int().nonnegative(),
  complete: z.boolean(),
}).strict();
