import { defineTool } from "eve/tools";
import { z } from "zod";

/** Fixture-only action that remains in flight until its turn is cancelled. */
export default defineTool({
  description: "Wait for the caller to cancel this test action.",
  inputSchema: z.object({}).strict(),
  async execute(_input,ctx) {
    await new Promise<void>((resolve,reject) => {
      if (ctx.abortSignal.aborted) { resolve(); return; }
      const timeout = setTimeout(() => { ctx.abortSignal.removeEventListener("abort",abort); reject(new Error("Cancellation fixture timed out.")); },20_000);
      const abort = () => { clearTimeout(timeout); ctx.abortSignal.removeEventListener("abort",abort); resolve(); };
      ctx.abortSignal.addEventListener("abort",abort,{ once: true });
    });
    ctx.abortSignal.throwIfAborted();
    return { completed: true };
  },
});
