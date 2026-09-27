import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { HookContext } from "eve/hooks";
import { accessOwner, operationId, type AccessOwner, type SessionAccessStore } from "../agent-access/contract";
import { requestHash } from "../agent-access/signing";
import { budgetPolicy, micros, type BudgetStore } from "./contract";
import { costBasis, quotedEnvelopeMicros } from "./cost-basis";
import { defaultMaxInputBytes, inputPayloadBytes, type ModelParams } from "./input";

export const runtimeBudgetSettings = z.object({ policy: budgetPolicy, estimateMicros: micros.positive(), maxModelCalls: z.number().int().min(1).max(1000), maxInputBytes: z.number().int().min(1).max(1024 * 1024).optional(), modelIds: z.array(z.string().min(1)).min(1).max(10), costBasis }).strict().superRefine((settings, ctx) => {
  if (settings.estimateMicros > settings.policy.dailyMicros) {
    ctx.addIssue({ code: "custom", path: ["estimateMicros"], message: "One reservation exceeds the daily allowance." });
  }
  const configured = new Set(settings.modelIds);
  const reviewed = new Set(settings.costBasis.models.map(model => model.id));
  if (configured.size !== settings.modelIds.length || reviewed.size !== settings.costBasis.models.length ||
      configured.size !== reviewed.size || [...configured].some(id => !reviewed.has(id))) {
    ctx.addIssue({ code: "custom", path: ["costBasis", "models"], message: "Cost basis must cover each allowed model exactly once." });
  }
  if (quotedEnvelopeMicros(settings.costBasis, settings.maxModelCalls) > BigInt(settings.estimateMicros)) {
    ctx.addIssue({ code: "custom", path: ["estimateMicros"], message: "Reservation is below the reviewed cost basis." });
  }
});
export type RuntimeBudgetSettings = z.infer<typeof runtimeBudgetSettings>;
/** Bind a ledger reservation to the entire reviewed envelope, not just its label.
 * A lost first-step checkpoint cannot re-admit that operation with wider limits.
 */
export function runtimeReservationPolicy(settings: RuntimeBudgetSettings) {
  const { policy, costBasis: basis } = settings;
  const fingerprint = createHash("sha256").update(JSON.stringify([
    "jumpstart-runtime-envelope-v3", policy.id, policy.dailyMicros, policy.maxActive, policy.maxPerMinute,
    settings.estimateMicros, settings.maxModelCalls, [...settings.modelIds].sort(),
    basis.sourceUrl, basis.reviewedAt, basis.maxOtherMicros, settings.maxInputBytes ?? defaultMaxInputBytes,
    [...basis.models].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      .map(model => [model.id, model.maxInputTokens, model.maxOutputTokens, model.inputMicrosPerMillion, model.outputMicrosPerMillion]),
  ])).digest("hex");
  return { ...policy,id: `runtime-v3:${fingerprint}` };
}
export function parseRuntimeBudgetSettings(raw: unknown) { return runtimeBudgetSettings.parse(raw); }
export function readRuntimeBudgetSettings(env: NodeJS.ProcessEnv = process.env) {
  if (!env.AI_BUDGET_POLICY_JSON) throw new Error("Configure the server-side AI budget policy before running account-owned sessions.");
  try { return parseRuntimeBudgetSettings(JSON.parse(env.AI_BUDGET_POLICY_JSON)); }
  catch { throw new Error("AI budget policy is invalid; review model prices, token assumptions and reservation amount."); }
}
type Run = { operationId: string; turnId: string; reported: number; knownMicros: number; unknown: boolean; open: boolean; pending: boolean; estimateMicros: number; maxModelCalls: number; modelIds: string[]; outputCaps?: { id: string; limit: number }[]; maxInputBytes?: number; reconciliationRequired?: boolean };
type ProviderCall = { owner: AccessOwner; sessionId: string; operationId: string; modelId: string; eventId: string; kind: "step" | "compaction"; calls: number };
export type RuntimeBudgetState = { turn: Run | null; compaction: Run | null; enforced?: boolean; providerCall?: ProviderCall | null };
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
  private outputCaps() { return this.settings.costBasis.models.map(model => ({ id: model.id, limit: model.maxOutputTokens })); }
  private owner(ctx: Context) {
    const initiator = ctx.session.auth.initiator, current = ctx.session.auth.current;
    if (initiator?.authenticator !== "jumpstart" || current?.authenticator !== "jumpstart" || current.principalId !== initiator.principalId || current.issuer !== initiator.issuer) throw new Error("Budget caller does not own this session.");
    return accessOwner.parse({ tenant: initiator.issuer, subject: initiator.principalId });
  }
  private async reserve(ctx: Context, id: string, hash: string) {
    const owner = this.owner(ctx);
    if (!await this.access.ownsSession(owner,ctx.session.id)) throw new Error("Session ownership is unavailable.");
    const result = await this.budgets.reserve({ ...owner, operationId: id, requestHash: hash, estimateMicros: this.settings.estimateMicros, policy: runtimeReservationPolicy(this.settings), now: this.clock() });
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
    this.state.update(s => ({ ...s, enforced: true, providerCall: null, turn: s.turn?.turnId === ctx.session.turn.id && s.turn.open ? s.turn : { operationId: id, turnId: ctx.session.turn.id, reported: 0, knownMicros: 0, unknown: false, open: true, pending: false, estimateMicros: this.settings.estimateMicros, maxModelCalls: this.settings.maxModelCalls, modelIds: [...this.settings.modelIds], outputCaps: this.outputCaps(), maxInputBytes: this.settings.maxInputBytes ?? defaultMaxInputBytes } }));
  }
  private async admitProvider(ctx: Context, run: Run, eventId: string, modelId: string, kind: ProviderCall["kind"]) {
    if (!run.modelIds.includes(modelId) || !this.settings.modelIds.includes(modelId)) throw new Error("The model is outside the budget policy.");
    const owner = this.owner(ctx);
    if (!await this.access.ownsSession(owner,ctx.session.id)) throw new Error("Session ownership is unavailable.");
    this.state.update(s => ({ ...s, enforced: true, providerCall: { owner, sessionId: ctx.session.id, operationId: run.operationId, modelId, eventId, kind, calls: 0 } }));
  }
  /** Called by model middleware for EVERY provider invocation, including SDK retries. */
  async prepareProviderCall(modelId: string, provider: string, params: ModelParams) {
    const saved = this.state.get(), call = saved.providerCall;
    if (!saved.enforced || !call || (call.modelId !== modelId && call.modelId !== `${provider}/${modelId}`))
      throw new Error("Model request has no matching admitted budget.");
    const run = call.kind === "compaction" && saved.compaction?.open ? saved.compaction : saved.turn;
    if (!run?.open || run.operationId !== call.operationId || !run.modelIds.includes(call.modelId) || !this.settings.modelIds.includes(call.modelId))
      throw new Error("Model request has no matching admitted budget.");
    const original = run.outputCaps?.find(model => model.id === call.modelId)?.limit;
    const current = this.settings.costBasis.models.find(model => model.id === call.modelId)?.maxOutputTokens;
    if (!original || !current) throw new Error("This admitted budget predates per-call output limits; start a new turn.");
    if (!run.maxInputBytes) throw new Error("This admitted budget predates input payload limits; start a new turn.");
    inputPayloadBytes(params,Math.min(run.maxInputBytes,this.settings.maxInputBytes ?? defaultMaxInputBytes));
    if (!await this.access.ownsSession(call.owner,call.sessionId)) throw new Error("Session ownership is unavailable.");
    // Never use a replayable event/turn ID for a billed provider attempt. A retry
    // must consume a new durable slot even when restored state lost its count.
    if (!await this.budgets.claimAttempt({ ...call.owner, operationId: run.operationId, attemptId: requestHash(`${call.eventId}:${randomUUID()}`),
      maxAttempts: Math.min(run.maxModelCalls,this.settings.maxModelCalls) })) throw new Error("AI model-call budget exhausted.");
    this.state.update(s => ({ ...s, providerCall: { ...call, calls: call.calls + 1 } }));
    return Math.min(original,current);
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
    await this.admitProvider(ctx,run,eventId,modelId,"step");
    this.state.update(s => ({ ...s, turn: { ...run, pending: true } }));
  }
  completeStep(costUsd: number | undefined) {
    const run = this.state.get().turn;
    const call = this.state.get().providerCall;
    if (!run?.open || !run.pending || call?.kind !== "step" || call.operationId !== run.operationId || !call.calls)
      throw new Error("Model usage has no admitted attempt.");
    const known = typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0;
    const amount = known ? Math.ceil(costUsd * 1_000_000) : 0;
    if (!Number.isSafeInteger(amount) || amount > 1_000_000_000_000) {
      this.state.update(s => ({ ...s, turn: { ...run, reconciliationRequired: true } }));
      throw new Error("Model cost requires reconciliation.");
    }
    this.state.update(s => ({ ...s, providerCall: null, turn: { ...run, pending: false, reported: run.reported+1, knownMicros: run.knownMicros+amount, unknown: run.unknown || !known } }));
  }
  async beginCompaction(ctx: Context, eventId: string, modelId: string) {
    const active = this.state.get().turn;
    if (active?.open && active.turnId === ctx.session.turn.id) {
      await this.admitProvider(ctx,active,eventId,modelId,"compaction");
      // Compaction completion carries no cost, so the turn remains conservatively priced.
      this.state.update(s => ({ ...s, turn: { ...active, unknown: true } }));
      return;
    }
    const id = stableBudgetId(`compaction:${ctx.session.id}:${eventId}`);
    await this.reserve(ctx,id,requestHash(eventId));
    const run = { operationId: id, turnId: ctx.session.turn.id, reported: 0, knownMicros: 0, unknown: true, open: true, pending: false, estimateMicros: this.settings.estimateMicros, maxModelCalls: this.settings.maxModelCalls, modelIds: [...this.settings.modelIds], outputCaps: this.outputCaps(), maxInputBytes: this.settings.maxInputBytes ?? defaultMaxInputBytes };
    this.state.update(s => ({ ...s, compaction: run }));
    await this.admitProvider(ctx,run,eventId,modelId,"compaction");
  }
  private async settle(ctx: Context, run: Run) {
    if (run.reconciliationRequired) throw new Error("Model cost requires reconciliation.");
    const owner = this.owner(ctx);
    const attempts = await this.budgets.attemptCount({ ...owner, operationId: run.operationId });
    // Admission alone is not evidence of a model request. The middleware claims
    // durably before provider entry; a zero count verifies zero model cost.
    const unknown = (attempts > 0 && (run.unknown || run.pending)) || attempts !== run.reported;
    // Never refund an interrupted/retried provider call whose usage was lost.
    // A known partial overage plus unknown usage needs an explicit adjustment.
    if (unknown && run.knownMicros > run.estimateMicros) throw new Error("Partial cost overage requires reconciliation.");
    if (!await this.budgets.settle({ ...owner, operationId: run.operationId, actualMicros: unknown ? null : run.knownMicros })) throw new Error("Usage settlement conflicts with the ledger.");
  }
  async endTurn(ctx: Context) {
    const run = this.state.get().turn;
    if (run?.open && run.turnId === ctx.session.turn.id) {
      await this.settle(ctx,run);
      this.state.update(s => ({ ...s, providerCall: null, turn: { ...run, open: false } }));
    }
    await this.endCompaction(ctx);
  }
  async endCompaction(ctx: Context) {
    const run = this.state.get().compaction;
    if (run?.open) {
      await this.settle(ctx,run);
      this.state.update(s => ({ ...s, compaction: { ...run, open: false } }));
    }
    this.state.update(s => ({ ...s, providerCall: s.providerCall?.kind === "compaction" ? null : s.providerCall }));
  }
}
