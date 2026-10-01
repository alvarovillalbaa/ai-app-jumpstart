import { z } from "zod";
import { micros } from "./contract";

const tokenCount = z.number().int().positive().max(10_000_000);
const price = z.number().int().nonnegative().max(1_000_000_000_000);

/** Operator-supplied assumptions, not a provider-enforced token limit. */
export const costBasis = z.object({
  sourceUrl: z.url().startsWith("https://").max(500).refine(value => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash;
  }, "Use a public pricing URL without credentials, query or fragment."),
  reviewedAt: z.iso.date(),
  models: z.array(z.object({
    id: z.string().min(1).max(200),
    maxInputTokens: tokenCount,
    maxOutputTokens: tokenCount,
    inputMicrosPerMillion: price,
    outputMicrosPerMillion: price,
  }).strict()).min(1).max(10),
  maxOtherMicros: micros,
}).strict();
export type CostBasis = z.infer<typeof costBasis>;

const maxReviewAgeDays = 30;
const millisecondsPerDay = 24 * 60 * 60 * 1000;

/** Require a recent operator review before release or new paid runtime work. */
export function requireRecentCostReview(reviewedAt: string, now = new Date()): void {
  const reviewDay = Date.parse(`${reviewedAt}T00:00:00Z`);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (!Number.isFinite(reviewDay) || !Number.isFinite(today)) {
    throw new Error("costBasis.reviewedAt must be a valid UTC date.");
  }
  if (reviewDay > today) throw new Error("costBasis.reviewedAt cannot be in the future.");
  if (today - reviewDay > maxReviewAgeDays * millisecondsPerDay) {
    throw new Error(`costBasis.reviewedAt is older than ${maxReviewAgeDays} UTC days; review current provider and Gateway prices.`);
  }
}

const million = BigInt(1_000_000);
function ceilDiv(numerator: bigint) { return (numerator + million - BigInt(1)) / million; }

/** Round each price component up before multiplying by possible model calls. */
export function quotedEnvelopeMicros(basis: CostBasis, maxModelCalls: number): bigint {
  const perCall = basis.models.map(model =>
    ceilDiv(BigInt(model.maxInputTokens) * BigInt(model.inputMicrosPerMillion)) +
    ceilDiv(BigInt(model.maxOutputTokens) * BigInt(model.outputMicrosPerMillion)));
  return BigInt(maxModelCalls) * perCall.reduce((max, value) => value > max ? value : max, BigInt(0)) + BigInt(basis.maxOtherMicros);
}
