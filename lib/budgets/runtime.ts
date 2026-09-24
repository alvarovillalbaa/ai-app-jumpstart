import { createHash } from "node:crypto";
import { z } from "zod";
import type { HookContext } from "eve/hooks";
import { accessOwner, operationId, type SessionAccessStore } from "../agent-access/contract";
import { requestHash } from "../agent-access/signing";
import { budgetPolicy, micros, type BudgetStore } from "./contract";

export const runtimeBudgetSettings = z.object({ policy: budgetPolicy, estimateMicros: micros.positive(), maxModelCalls: z.number().int().min(1).max(1000), modelIds: z.array(z.string().min(1)).min(1).max(10) }).strict();
export type RuntimeBudgetSettings = z.infer<typeof runtimeBudgetSettings>;
export function readRuntimeBudgetSettings() {
  if (!process.env.AI_BUDGET_POLICY_JSON) throw new Error("Configure the server-side AI budget policy before running account-owned sessions.");
  return runtimeBudgetSettings.parse(JSON.parse(process.env.AI_BUDGET_POLICY_JSON));
}
type Run = { operationId: string; turnId: string; reported: number; knownMicros: number; unknown: boolean; open: boolean; pending: boolean; estimateMicros: number; maxModelCalls: number; modelIds: string[]; reconciliationRequired?: boolean };
export type RuntimeBudgetState = { turn: Run | null; compaction: Run | null };
export interface BudgetStateHandle { get(): RuntimeBudgetState; update(fn: (state: RuntimeBudgetState) => RuntimeBudgetState): void }
type Context = Pick<HookContext,"session">;
export function stableBudgetId(value: string) {
  const bytes = createHash("sha256").update(value).digest().subarray(0,16);
  bytes[6] = (bytes[6] & 15) | 128; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex"); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

/** Runtime-only lifecycle controller. No caller-provided policy or usage inputs. */
export class RuntimeBudgets {
  constructor(private budgets: BudgetStore, private access: SessionAccessStore, private state: BudgetStateHandle,
    private settings: RuntimeBudgetSettings, private clock = Date.now) {}
  private owner(ctx: Context) {
    const initiator = ctx.session.auth.initiator, current = ctx.session.auth.current;
    if (initiator?.authenticator !== "jumpstart" || current?.authenticator !== "jumpstart" || current.principalId !== initiator.principalId || current.issuer !== initiator.issuer) throw new Error("Budget caller does not own this session.");
    return accessOwner.parse({ tenant: initiator.issuer, subject: initiator.principalId });
  }
  private async reserve(ctx: Context, id: string, hash: string) {
    const owner = this.owner(ctx);
    if (!await this.access.ownsSession(owner,ctx.session.id)) throw new Error("Session ownership is unavailable.");
    const result = await this.budgets.reserve({ ...owner, operationId: id, requestHash: hash, estimateMicros: this.settings.estimateMicros, policy: this.settings.policy, now: this.clock() });
    if (result.status !== "reserved") throw new Error(result.status === "denied" ? `AI budget admission denied: ${result.reason}` : "This execution budget has already settled.");
  }
  async beginTurn(ctx: Context) {
    const owner = this.owner(ctx), creation = operationId.parse(ctx.session.auth.initiator!.attributes.creationOperationId);
    const row = await this.access.getOperation(owner,creation);
    if (!row) throw new Error("Creation reservation missing.");
    const first = ctx.session.turn.sequence === 0;
    const turnKey = ctx.session.turn.id || `continuation:${ctx.session.turn.sequence}`;
    const id = first ? creation : stableBudgetId(JSON.stringify([owner,ctx.session.id,turnKey]));
    await this.reserve(ctx,id,first ? row.requestHash : requestHash(JSON.stringify([ctx.session.id,turnKey])));
    this.state.update(s => ({ ...s, turn: s.turn?.turnId === ctx.session.turn.id && s.turn.open ? s.turn : { operationId: id, turnId: ctx.session.turn.id, reported: 0, knownMicros: 0, unknown: false, open: true, pending: false, estimateMicros: this.settings.estimateMicros, maxModelCalls: this.settings.maxModelCalls, modelIds: [...this.settings.modelIds] } }));
  }
  private async claim(ctx: Context, run: Run, eventId: string, modelId: string) {
    if (!run.modelIds.includes(modelId) || !this.settings.modelIds.includes(modelId)) throw new Error("The model is outside the budget policy.");
    const owner = this.owner(ctx);
    if (!await this.access.ownsSession(owner,ctx.session.id)) throw new Error("Session ownership is unavailable.");
    if (!await this.budgets.claimAttempt({ ...owner, operationId: run.operationId, attemptId: requestHash(eventId), maxAttempts: Math.min(run.maxModelCalls,this.settings.maxModelCalls) })) throw new Error("AI model-call budget exhausted.");
  }
  async beginStep(ctx: Context, eventId: string, modelId: string, continuationSequence?: number) {
    let run = this.state.get().turn;
    // Eve's approval response resumes with a blank event turn ID and no
    // turn.started, while ctx.session.turn carries the generated turn ID.
    // Admit only that continuation; ordinary turns still require turn.started.
    if ((!run?.open || run.turnId !== ctx.session.turn.id) && continuationSequence === ctx.session.turn.sequence && continuationSequence > 0) {
      await this.beginTurn(ctx);
      run = this.state.get().turn;
    }
    if (!run?.open || run.turnId !== ctx.session.turn.id) throw new Error("No admitted turn budget.");
    await this.claim(ctx,run,eventId,modelId);
    this.state.update(s => ({ ...s, turn: { ...run, pending: true } }));
  }
  completeStep(costUsd: number | undefined) {
    const run = this.state.get().turn;
    if (!run?.open || !run.pending) throw new Error("Model usage has no admitted attempt.");
    const known = typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0;
    const amount = known ? Math.ceil(costUsd * 1_000_000) : 0;
    if (!Number.isSafeInteger(amount) || amount > 1_000_000_000_000) {
      this.state.update(s => ({ ...s, turn: { ...run, reconciliationRequired: true } }));
      throw new Error("Model cost requires reconciliation.");
    }
    this.state.update(s => ({ ...s, turn: { ...run, pending: false, reported: run.reported+1, knownMicros: run.knownMicros+amount, unknown: run.unknown || !known } }));
  }
  async beginCompaction(ctx: Context, eventId: string, modelId: string) {
    const active = this.state.get().turn;
    if (active?.open && active.turnId === ctx.session.turn.id) {
      await this.claim(ctx,active,eventId,modelId);
      // Compaction completion carries no cost, so the turn remains conservatively priced.
      this.state.update(s => ({ ...s, turn: { ...active, unknown: true } }));
      return;
    }
    const id = stableBudgetId(`compaction:${ctx.session.id}:${eventId}`);
    await this.reserve(ctx,id,requestHash(eventId));
    const run = { operationId: id, turnId: ctx.session.turn.id, reported: 0, knownMicros: 0, unknown: true, open: true, pending: false, estimateMicros: this.settings.estimateMicros, maxModelCalls: this.settings.maxModelCalls, modelIds: [...this.settings.modelIds] };
    this.state.update(s => ({ ...s, compaction: run }));
    await this.claim(ctx,run,eventId,modelId);
  }
  private async settle(ctx: Context, run: Run) {
    if (run.reconciliationRequired) throw new Error("Model cost requires reconciliation.");
    const owner = this.owner(ctx);
    const attempts = await this.budgets.attemptCount({ ...owner, operationId: run.operationId });
    const unknown = run.unknown || run.pending || attempts !== run.reported;
    // Never refund an interrupted/retried provider call whose usage was lost.
    // A known partial overage plus unknown usage needs an explicit adjustment.
    if (unknown && run.knownMicros > run.estimateMicros) throw new Error("Partial cost overage requires reconciliation.");
    if (!await this.budgets.settle({ ...owner, operationId: run.operationId, actualMicros: unknown ? null : run.knownMicros })) throw new Error("Usage settlement conflicts with the ledger.");
  }
  async endTurn(ctx: Context) {
    const run = this.state.get().turn;
    if (run?.open && run.turnId === ctx.session.turn.id) {
      await this.settle(ctx,run);
      this.state.update(s => ({ ...s, turn: { ...run, open: false } }));
    }
    await this.endCompaction(ctx);
  }
  async endCompaction(ctx: Context) {
    const run = this.state.get().compaction;
    if (run?.open) {
      await this.settle(ctx,run);
      this.state.update(s => ({ ...s, compaction: { ...run, open: false } }));
    }
  }
}
