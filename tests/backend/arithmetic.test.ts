import { expect, it } from "vitest";
import { calculate } from "../../agent/lib/arithmetic";
it.each([
  ["add", 4, 5, 9], ["subtract", 4, 5, -1], ["multiply", 17, 23, 391], ["divide", 9, 3, 3],
])("calculates %s", (operation, left, right, result) => {
  expect(calculate({ operation, left, right })).toEqual({ ok: true, result });
});
it("rejects unsafe inputs and distinguishes division errors from successful answers", () => {
  expect(calculate({ operation: "divide", left: 1, right: 0 })).toEqual({ ok: false, error: "division_by_zero" });
  expect(() => calculate({ operation: "add", left: Infinity, right: 1 })).toThrow();
  expect(() => calculate({ operation: "add", left: 1, right: 1, command: "execute" })).toThrow();
});
