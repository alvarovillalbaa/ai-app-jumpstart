import { defineHook } from "eve/hooks";
import { getSessionAccessStore } from "../../lib/agent-access/store";
import { recordRuntimeSession } from "../../lib/agent-access/runtime-receipt";
import { runtimeBudgets } from "#lib/budgets.ts";
import { persistRuntimeProjection } from "../../lib/agent-access/projection";

export default defineHook({
  events: {
    async "*"(event,ctx) {
      if (ctx.session.auth.initiator?.authenticator !== "jumpstart") return;
      try { await persistRuntimeProjection(await getSessionAccessStore(),event,ctx); }
      catch {
        // The source event is already durable in Eve. A failed secondary copy
        // must not turn a completed turn into a failure or repeat model work.
        console.error(JSON.stringify({ event: "projection_write_failed",sourceEventId: event.meta.id }));
      }
    },
    async "turn.started"(_event, ctx) {
      if (ctx.session.auth.initiator?.authenticator !== "jumpstart") return;
      // A thrown hook stops the turn before its model call. Do not swallow a
      // failed binding: both ownership and lost-response recovery depend on it.
      await recordRuntimeSession(await getSessionAccessStore(), ctx);
      await (await runtimeBudgets()).beginTurn(ctx);
    },
    async "step.started"(event,ctx) {
      if (ctx.session.auth.initiator?.authenticator === "jumpstart") await (await runtimeBudgets()).beginStep(ctx,event.meta.id,event.data.modelId,event.data.turnId === "" ? event.data.sequence : undefined);
    },
    async "step.completed"(event,ctx) {
      if (ctx.session.auth.initiator?.authenticator === "jumpstart") (await runtimeBudgets()).completeStep(event.data.usage?.costUsd);
    },
    async "compaction.requested"(event,ctx) {
      if (ctx.session.auth.initiator?.authenticator === "jumpstart") await (await runtimeBudgets()).beginCompaction(ctx,event.meta.id,event.data.modelId);
    },
    async "compaction.completed"(_event,ctx) {
      if (ctx.session.auth.initiator?.authenticator === "jumpstart") await (await runtimeBudgets()).endCompaction(ctx);
    },
    async "turn.completed"(_event,ctx) {
      if (ctx.session.auth.initiator?.authenticator === "jumpstart") await (await runtimeBudgets()).endTurn(ctx);
    },
    async "turn.failed"(_event,ctx) {
      if (ctx.session.auth.initiator?.authenticator === "jumpstart") await (await runtimeBudgets()).endTurn(ctx);
    },
    async "turn.cancelled"(_event,ctx) {
      if (ctx.session.auth.initiator?.authenticator === "jumpstart") await (await runtimeBudgets()).endTurn(ctx);
    },
    async "session.waiting"(_event,ctx) {
      if (ctx.session.auth.initiator?.authenticator === "jumpstart") await (await runtimeBudgets()).endCompaction(ctx);
    },
  },
});
