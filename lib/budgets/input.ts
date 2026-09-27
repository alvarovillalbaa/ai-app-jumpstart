import type { LanguageModelMiddleware } from "ai";

export type ModelParams = Parameters<NonNullable<LanguageModelMiddleware["transformParams"]>>[0]["params"];
export const defaultMaxInputBytes = 256 * 1024;

/** Exact UTF-8 JSON size of the SDK content envelope, not a token estimate or
 * provider wire size. Stop counting on overflow without serializing the body.
 */
export function inputPayloadBytes(params: ModelParams, limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Model input payload budget is invalid.");
  let bytes = 0;
  const ancestors = new Set<object>();
  function add(amount: number) {
    bytes += amount;
    if (bytes > limit) throw new Error("Model input exceeds its admitted payload limit.");
  }
  function string(value: string) {
    add(2); // JSON quotes
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) add(2);
      else if (code < 32) add(6);
      else if (code < 128) add(1);
      else if (code < 2048) add(2);
      else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(i+1) >= 0xdc00 && value.charCodeAt(i+1) <= 0xdfff) { add(4); i++; }
      else if (code >= 0xd800 && code <= 0xdfff) add(6); // well-formed JSON escapes lone surrogates
      else add(3);
    }
  }
  function visit(value: unknown, depth: number) {
    if (depth > 64) throw new Error("Model input payload nesting is unsupported.");
    if (value === null || value === undefined) { add(4); return; }
    if (typeof value === "string") { string(value); return; }
    if (typeof value === "boolean") { add(value ? 4 : 5); return; }
    if (typeof value === "number" && Number.isFinite(value)) { add(JSON.stringify(value).length); return; }
    if (typeof value !== "object") throw new Error("Model input payload is not supported JSON.");
    if (ancestors.has(value)) throw new Error("Model input payload is not supported JSON.");
    const toJSON = Object.getOwnPropertyDescriptor(value,"toJSON");
    if (toJSON && (!Object.hasOwn(toJSON,"value") || typeof toJSON.value === "function"))
      throw new Error("Model input payload is not supported JSON.");
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) throw new Error("Model input payload is not supported JSON.");
    ancestors.add(value); add(2);
    if (array) {
      for (let i = 0; i < value.length; i++) {
        if (i) add(1);
        const descriptor = Object.getOwnPropertyDescriptor(value,String(i));
        if (descriptor && !Object.hasOwn(descriptor,"value")) throw new Error("Model input payload is not supported JSON.");
        visit(descriptor?.value,depth+1);
      }
    } else {
      let first = true;
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value,key)!;
        if (!Object.hasOwn(descriptor,"value")) throw new Error("Model input payload is not supported JSON.");
        if (descriptor.value === undefined) continue;
        if (!first) add(1); first = false;
        string(key); add(1); visit(descriptor.value,depth+1);
      }
    }
    ancestors.delete(value);
  }
  visit({ prompt: params.prompt, tools: params.tools, toolChoice: params.toolChoice,
    responseFormat: params.responseFormat, providerOptions: params.providerOptions, stopSequences: params.stopSequences },0);
  return bytes;
}
