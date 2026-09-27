import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { APICallError, customProvider, generateText, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { installBudgetProvider, modelWithBudget } from "../../lib/budgets/model";
import { inputPayloadBytes, type ModelParams } from "../../lib/budgets/input";
import { RuntimeBudgets, type RuntimeBudgetState } from "../../lib/budgets/runtime";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { sqliteBudgetStore } from "../../lib/budgets/sqlite";

const owner = { tenant: "test", subject: "alice" };
const settings = { policy: { id: "fixture", dailyMicros: 200, maxActive: 1, maxPerMinute: 10 }, estimateMicros: 100, maxModelCalls: 2, modelIds: ["fixture/model"],
  costBasis: { sourceUrl: "https://example.test/fixture-prices", reviewedAt: "2026-09-24", maxOtherMicros: 0,
    models: [{ id: "fixture/model", maxInputTokens: 1, maxOutputTokens: 16, inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000 }] } };
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const response = { content: [{ type: "text" as const, text: "ok" }], finishReason: { unified: "stop" as const, raw: undefined }, usage, warnings: [] };
const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "private prompt" }] }];
let access: ReturnType<typeof sqliteAccessStore>, budgets: ReturnType<typeof sqliteBudgetStore>, state: RuntimeBudgetState, runtime: RuntimeBudgets, operationId: string;
const handle = { get: () => state, update: (fn: (state: RuntimeBudgetState) => RuntimeBudgetState) => { state = fn(state); } };
function context() {
  const auth = { authenticator: "jumpstart", principalType: "user", principalId: owner.subject, issuer: owner.tenant, attributes: { creationOperationId: operationId } };
  return { session: { id: "session", turn: { id: "turn", sequence: 0 }, auth: { current: auth, initiator: auth } } };
}
function fake() {
  return new MockLanguageModelV4({ provider: "fixture", modelId: "model", doGenerate: response, doStream: {
    stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: "text-start", id: "one" }); controller.enqueue({ type: "text-delta", id: "one", delta: "ok" });
      controller.enqueue({ type: "text-end", id: "one" }); controller.enqueue({ type: "finish", finishReason: response.finishReason, usage }); controller.close();
    } }),
  } });
}
beforeEach(async () => {
  access = sqliteAccessStore(":memory:"); budgets = sqliteBudgetStore(":memory:"); state = { turn: null, compaction: null }; operationId = randomUUID();
  await access.reserve({ ...owner, id: randomUUID(), operationId, requestHash: "a".repeat(64) }); await access.bind(owner, operationId, "session");
  runtime = new RuntimeBudgets(budgets, access, handle, settings);
  await runtime.beginTurn(context()); await runtime.beginStep(context(), "event", "fixture/model");
});
afterEach(async () => { await access.close(); await budgets.close(); });

it("bounds both generated and streamed provider parameters without changing identity, prompt, tools or options", async () => {
  const provider = fake(), wrapped = modelWithBudget(provider, (id, name, params) => runtime.prepareProviderCall(id, name, params));
  const tools = [{ type: "function" as const, name: "read", inputSchema: { type: "object" as const } }];
  const params = { prompt, tools, providerOptions: { fixture: { safe: true } }, maxOutputTokens: 1000 };
  await wrapped.doGenerate(params);
  expect(provider.doGenerateCalls[0]).toEqual({ ...params, maxOutputTokens: 16 });
  await wrapped.doStream({ ...params, maxOutputTokens: 4 });
  expect(provider.doStreamCalls[0]).toEqual({ ...params, maxOutputTokens: 4 });
  expect(wrapped.modelId).toBe(provider.modelId); expect(wrapped.provider).toBe(provider.provider);
  expect(params.maxOutputTokens).toBe(1000);
  expect(await budgets.attemptCount({ ...owner, operationId })).toBe(2);
  await expect(wrapped.doGenerate(params)).rejects.toThrow("exhausted");
  expect(provider.doGenerateCalls).toHaveLength(1);
});

it("counts AI SDK network retries inside one admitted step and blocks the next request before the provider", async () => {
  const provider = new MockLanguageModelV4({ provider: "fixture", modelId: "model", doGenerate: async () => {
    throw new APICallError({ message: "Fixture rate limit", url: "https://example.test/model", requestBodyValues: {}, statusCode: 429, isRetryable: true });
  } });
  const wrapped = modelWithBudget(provider, (id, name, params) => runtime.prepareProviderCall(id, name, params));
  await expect(generateText({ model: wrapped, prompt: "retry fixture", maxRetries: 5 })).rejects.toThrow("exhausted");
  expect(provider.doGenerateCalls).toHaveLength(2);
  expect(provider.doGenerateCalls.every(call => call.maxOutputTokens === 16)).toBe(true);
  expect(await budgets.attemptCount({ ...owner, operationId })).toBe(2);
  await runtime.endTurn(context());
  expect(await budgets.snapshot({ ...owner, now: Date.now() })).toMatchObject({ chargedMicros: 100, unknownCosts: 1 });
}, 15_000);

it("applies the provider boundary to the actual AI SDK streaming path", async () => {
  const provider = fake(), wrapped = modelWithBudget(provider, (id, name, params) => runtime.prepareProviderCall(id, name, params));
  const result = streamText({ model: wrapped, prompt: "stream fixture" });
  expect(await result.text).toBe("ok");
  expect(provider.doStreamCalls[0].maxOutputTokens).toBe(16);
  expect(await budgets.attemptCount({ ...owner, operationId })).toBe(1);
});

it("preserves string model resolution through the configured provider and installs only once", async () => {
  const previous = globalThis.AI_SDK_DEFAULT_PROVIDER, provider = fake();
  try {
    globalThis.AI_SDK_DEFAULT_PROVIDER = customProvider({ languageModels: { "fixture/model": provider } });
    const prepare = (id: string, name: string, params: ModelParams) => runtime.prepareProviderCall(id,name,params);
    installBudgetProvider(prepare);
    const installed = globalThis.AI_SDK_DEFAULT_PROVIDER;
    installBudgetProvider(prepare); expect(globalThis.AI_SDK_DEFAULT_PROVIDER).toBe(installed);
    expect((await generateText({ model: "fixture/model",prompt: "same string",maxRetries: 0 })).text).toBe("ok");
    expect(provider.doGenerateCalls[0].maxOutputTokens).toBe(16);
    expect(installed!.languageModel("fixture/model")).toMatchObject({ provider: "fixture",modelId: "model" });
    expect(await budgets.attemptCount({ ...owner,operationId })).toBe(1);
  } finally { globalThis.AI_SDK_DEFAULT_PROVIDER = previous; }
});

it("cannot widen restored output caps and immediately honors a tighter deployment cap", async () => {
  const provider = fake();
  const changed = (limit: number) => new RuntimeBudgets(budgets, access, handle, { ...settings,
    costBasis: { ...settings.costBasis, models: [{ ...settings.costBasis.models[0], maxOutputTokens: limit }] } });
  let controller = changed(1000);
  const wrapped = modelWithBudget(provider, (id, name, params) => controller.prepareProviderCall(id, name, params));
  await wrapped.doGenerate({ prompt }); expect(provider.doGenerateCalls[0].maxOutputTokens).toBe(16);
  state = structuredClone(state); controller = changed(8);
  await wrapped.doGenerate({ prompt }); expect(provider.doGenerateCalls[1].maxOutputTokens).toBe(8);
});

it("does not reuse a provider attempt after restoring an earlier context or raising the call cap", async () => {
  const restored = structuredClone(state), provider = fake();
  let controller = runtime;
  const wrapped = modelWithBudget(provider, (id, name, params) => controller.prepareProviderCall(id, name, params));
  await wrapped.doGenerate({ prompt }); state = restored;
  controller = new RuntimeBudgets(budgets, access, handle, { ...settings, maxModelCalls: 100 });
  await wrapped.doGenerate({ prompt });
  await expect(wrapped.doGenerate({ prompt })).rejects.toThrow("exhausted");
  expect(provider.doGenerateCalls).toHaveLength(2);
  expect(await budgets.attemptCount({ ...owner, operationId })).toBe(2);
});

it("rejects a changed reservation envelope even when the first-step checkpoint was entirely lost", async () => {
  const provider = fake(), wrapped = modelWithBudget(provider, (id, name, params) => runtime.prepareProviderCall(id, name, params));
  await wrapped.doGenerate({ prompt });
  state = { turn: null, compaction: null };
  const changed = new RuntimeBudgets(budgets, access, handle, { ...settings,
    costBasis: { ...settings.costBasis, models: [{ ...settings.costBasis.models[0], maxOutputTokens: 32 }] } });
  await expect(changed.beginTurn(context())).rejects.toThrow("conflict");
  expect(provider.doGenerateCalls).toHaveLength(1);
  expect(await budgets.attemptCount({ ...owner, operationId })).toBe(1);
  expect(await budgets.snapshot({ ...owner, now: Date.now() })).toMatchObject({ active: 1, reservedMicros: 100 });
});

it("denies oversize prompts and tool context before claiming an attempt or reaching the provider", async () => {
  const provider = fake(), wrapped = modelWithBudget(provider,(id,name,params) => runtime.prepareProviderCall(id,name,params));
  state.turn!.maxInputBytes = inputPayloadBytes({ prompt },1000);
  await expect(wrapped.doGenerate({ prompt: [{ role: "system",content: "private oversized text".repeat(100) }] })).rejects.toThrow("payload limit");
  await expect(wrapped.doStream({ prompt,tools: [{ type: "function",name: "read",description: "extra context",inputSchema: {} }] })).rejects.toThrow("payload limit");
  expect(provider.doGenerateCalls).toHaveLength(0); expect(provider.doStreamCalls).toHaveLength(0);
  expect(await budgets.attemptCount({ ...owner,operationId })).toBe(0);
  await wrapped.doGenerate({ prompt }); expect(provider.doGenerateCalls).toHaveLength(1);
});

it("preserves the admitted payload cap on restore, honors tightening and denies legacy input envelopes", async () => {
  const provider = fake(), bytes = inputPayloadBytes({ prompt },1000);
  state.turn!.maxInputBytes = bytes;
  let controller = new RuntimeBudgets(budgets,access,handle,{ ...settings,maxInputBytes: 1000 });
  const wrapped = modelWithBudget(provider,(id,name,params) => controller.prepareProviderCall(id,name,params));
  state = structuredClone(state);
  await expect(wrapped.doGenerate({ prompt,providerOptions: { fixture: { extra: true } } })).rejects.toThrow("payload limit");
  controller = new RuntimeBudgets(budgets,access,handle,{ ...settings,maxInputBytes: bytes-1 });
  await expect(wrapped.doGenerate({ prompt })).rejects.toThrow("payload limit");
  delete state.turn!.maxInputBytes;
  await expect(wrapped.doGenerate({ prompt })).rejects.toThrow("predates input");
  expect(provider.doGenerateCalls).toHaveLength(0); expect(await budgets.attemptCount({ ...owner,operationId })).toBe(0);
});

it("settles denied input at verified zero when no provider attempt exists, including manual compaction", async () => {
  const provider = fake(), wrapped = modelWithBudget(provider,(id,name,params) => runtime.prepareProviderCall(id,name,params));
  state.turn!.maxInputBytes = 1;
  await expect(wrapped.doGenerate({ prompt })).rejects.toThrow("payload limit");
  await runtime.endTurn(context());
  expect(await budgets.snapshot({ ...owner,now: Date.now() })).toMatchObject({ chargedMicros: 0,active: 0,unknownCosts: 0 });
  await runtime.beginCompaction(context(),"input-denied-compaction","fixture/model");
  state.compaction!.maxInputBytes = 1;
  await expect(wrapped.doGenerate({ prompt })).rejects.toThrow("payload limit");
  await runtime.endCompaction(context());
  expect(await budgets.snapshot({ ...owner,now: Date.now() })).toMatchObject({ chargedMicros: 0,active: 0,unknownCosts: 0 });
  expect(provider.doGenerateCalls).toHaveLength(0);
});

it("rejects mismatched models, legacy envelopes and revoked ownership before networking", async () => {
  const provider = fake(), wrapped = modelWithBudget(provider, (id, name, params) => runtime.prepareProviderCall(id, name, params));
  await expect(runtime.prepareProviderCall("another", "fixture",{ prompt })).rejects.toThrow("matching admitted");
  const caps = state.turn!.outputCaps; delete state.turn!.outputCaps;
  await expect(wrapped.doGenerate({ prompt })).rejects.toThrow("predates per-call");
  state.turn!.outputCaps = caps;
  expect(await access.revoke(owner, (await access.getOperation(owner, operationId))!.id)).toBe(true);
  await expect(wrapped.doGenerate({ prompt })).rejects.toThrow("ownership");
  expect(provider.doGenerateCalls).toHaveLength(0); expect(await budgets.attemptCount({ ...owner, operationId })).toBe(0);
});

it("uses the same limits for automatic and independent manual compaction", async () => {
  const provider = fake(), wrapped = modelWithBudget(provider, (id, name, params) => runtime.prepareProviderCall(id, name, params));
  await runtime.beginCompaction(context(), "auto", "fixture/model");
  await wrapped.doGenerate({ prompt }); await runtime.endCompaction(context());
  await expect(wrapped.doGenerate({ prompt })).rejects.toThrow("matching admitted");
  await runtime.endTurn(context());
  await runtime.beginCompaction(context(), "manual", "fixture/model");
  await wrapped.doGenerate({ prompt }); await runtime.endCompaction(context());
  expect(provider.doGenerateCalls.map(call => call.maxOutputTokens)).toEqual([16, 16]);
  expect(await budgets.snapshot({ ...owner, now: Date.now() })).toMatchObject({ chargedMicros: 200, active: 0 });
});

it("passes unowned development calls through and refuses invalid output limits", async () => {
  const provider = fake(), wrapped = modelWithBudget(provider, async () => undefined);
  await wrapped.doGenerate({ prompt, maxOutputTokens: 12 });
  expect(provider.doGenerateCalls[0].maxOutputTokens).toBe(12);
  await expect(wrapped.doGenerate({ prompt, maxOutputTokens: -1 })).rejects.toThrow("positive safe integer");
  expect(provider.doGenerateCalls).toHaveLength(1);
});
