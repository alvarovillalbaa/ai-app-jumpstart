import { gateway, wrapLanguageModel, wrapProvider, type LanguageModel, type LanguageModelMiddleware } from "ai";
import type { ModelParams } from "./input";
import { observeRuntimeBudgetAttempt, type RuntimeBudgetAttemptPhase } from "../observability/runtime";
import type { AuditSink } from "../observability/runtime";

type PreparedCall = { outputCap: number; attempt: Parameters<typeof observeRuntimeBudgetAttempt>[0]; auditSink: AuditSink };
type Prepare = (modelId: string, provider: string, params: ModelParams) => Promise<PreparedCall | undefined>;
function budgetMiddleware(prepare: Prepare): LanguageModelMiddleware {
  const preparedByParams = new WeakMap<object,PreparedCall>();
  const report = (prepared: PreparedCall,phase: RuntimeBudgetAttemptPhase,usage?: { inputTokens?: number; outputTokens?: number }) =>
    observeRuntimeBudgetAttempt(prepared.attempt,phase,prepared.auditSink,usage);
  return {
    async transformParams({ params,model }) {
      const requested = params.maxOutputTokens;
      if (requested !== undefined && (!Number.isSafeInteger(requested) || requested < 1))
        throw new Error("Model output limit must be a positive safe integer.");
      const prepared = await prepare(model.modelId,model.provider,params);
      if (prepared === undefined) return params;
      if (!Number.isSafeInteger(prepared.outputCap) || prepared.outputCap < 1) throw new Error("Model output budget is invalid.");
      const transformed = { ...params,maxOutputTokens: Math.min(requested ?? prepared.outputCap,prepared.outputCap) };
      preparedByParams.set(transformed,prepared);
      return transformed;
    },
    async wrapGenerate({ params,doGenerate }) {
      const prepared = preparedByParams.get(params);
      if (!prepared) return doGenerate();
      preparedByParams.delete(params);
      try {
        const result = await doGenerate();
        report(prepared,"completed",{ inputTokens: result.usage.inputTokens.total,outputTokens: result.usage.outputTokens.total });
        return result;
      } catch (error) {
        report(prepared,"failed");
        throw error;
      }
    },
    async wrapStream({ params,doStream }) {
      const prepared = preparedByParams.get(params);
      if (!prepared) return doStream();
      preparedByParams.delete(params);
      let result;
      try { result = await doStream(); }
      catch (error) { report(prepared,"failed"); throw error; }
      let terminal = false;
      const finish = (phase: RuntimeBudgetAttemptPhase,usage?: { inputTokens?: number; outputTokens?: number }) => {
        if (terminal) return;
        terminal = true;
        report(prepared,phase,usage);
      };
      const reader = result.stream.getReader();
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const item = await reader.read();
            if (item.done) { finish("incomplete"); controller.close(); return; }
            if (item.value.type === "finish") finish("completed",{ inputTokens: item.value.usage.inputTokens.total,outputTokens: item.value.usage.outputTokens.total });
            else if (item.value.type === "error") finish("failed");
            controller.enqueue(item.value);
          } catch (error) {
            finish("failed");
            controller.error(error);
          }
        },
        async cancel(reason) {
          finish("cancelled");
          await reader.cancel(reason);
        },
      }) as typeof result.stream;
      return { ...result,stream };
    },
  };
}

const installed = new WeakSet<object>();
/** Preserve AI SDK string model resolution and the selected provider's routing. */
export function installBudgetProvider(prepare: Prepare) {
  const provider = globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway;
  if (installed.has(provider)) return;
  const bounded = wrapProvider({ provider, languageModelMiddleware: budgetMiddleware(prepare) });
  installed.add(bounded);
  globalThis.AI_SDK_DEFAULT_PROVIDER = bounded;
}

/** Provider boundary: AI SDK retries re-enter this middleware before networking. */
export function modelWithBudget(model: Exclude<LanguageModel,string>, prepare: Prepare) {
  return wrapLanguageModel({ model, middleware: budgetMiddleware(prepare) });
}
