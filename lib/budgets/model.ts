import { gateway, wrapLanguageModel, wrapProvider, type LanguageModel, type LanguageModelMiddleware } from "ai";

type Prepare = (modelId: string, provider: string) => Promise<number | undefined>;
function budgetMiddleware(prepare: Prepare): LanguageModelMiddleware {
  return {
    async transformParams({ params,model }) {
      const requested = params.maxOutputTokens;
      if (requested !== undefined && (!Number.isSafeInteger(requested) || requested < 1))
        throw new Error("Model output limit must be a positive safe integer.");
      const cap = await prepare(model.modelId,model.provider);
      if (cap === undefined) return params;
      if (!Number.isSafeInteger(cap) || cap < 1) throw new Error("Model output budget is invalid.");
      return { ...params,maxOutputTokens: Math.min(requested ?? cap,cap) };
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
