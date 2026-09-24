import { z } from "zod";
export const arithmeticInput = z.object({
  operation: z.enum(["add", "subtract", "multiply", "divide"]),
  left: z.number().finite().min(-1e12).max(1e12),
  right: z.number().finite().min(-1e12).max(1e12),
}).strict();
export function calculate(value: unknown) {
  const { operation, left, right } = arithmeticInput.parse(value);
  if (operation === "divide" && right === 0) return { ok: false as const, error: "division_by_zero" };
  const result = operation === "add" ? left + right : operation === "subtract" ? left - right : operation === "multiply" ? left * right : left / right;
  if (!Number.isFinite(result)) return { ok: false as const, error: "non_finite_result" };
  return { ok: true as const, result };
}
