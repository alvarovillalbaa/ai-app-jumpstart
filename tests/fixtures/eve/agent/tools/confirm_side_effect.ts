import { appendFile } from "node:fs/promises";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

/** Fixture-only side effect used to prove approval pauses execution. */
export default defineTool({
  description: "Perform a deterministic fixture side effect only after explicit user approval.",
  inputSchema: z.object({ title: z.string().min(1),content: z.string().min(1) }).strict(),
  approval: always(),
  async execute(input) {
    const receipts = process.env.EVE_EVAL_SIDE_EFFECT_RECEIPTS;
    if (!receipts) throw new Error("The isolated AI eval receipt path is required.");
    await appendFile(receipts, `${JSON.stringify(input)}\n`, { mode: 0o600 });
    return { performed: true,title: input.title };
  },
});
