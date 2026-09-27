import { expect, it } from "vitest";
import { inputPayloadBytes, type ModelParams } from "../../lib/budgets/input";

it("counts JSON formatting, UTF-8, escapes, Unicode and lone surrogates exactly", () => {
  // Compare with the actual JSON encoder, including randomized UTF-16 input.
  let seed = 7, generated = "";
  for (let i = 0; i < 1000; i++) { seed = (Math.imul(seed,1664525)+1013904223) >>> 0; generated += String.fromCharCode(seed & 0xffff); }
  for (const content of ["", 'quote"\\\n\r\t\b\f\u0000', "café 漢字 😀", "\ud800\udfff\udfff\ud800", generated]) {
    const params: ModelParams = { prompt: [{ role: "system",content }] };
    const bytes = Buffer.byteLength(JSON.stringify({ prompt: params.prompt }),"utf8");
    expect(inputPayloadBytes(params,bytes)).toBe(bytes);
    expect(() => inputPayloadBytes(params,bytes-1)).toThrow("payload limit");
  }
});

it("includes tools, schemas, structured output, provider context and stop sequences", () => {
  const envelope = {
    prompt: [{ role: "tool" as const,content: [{ type: "tool-result" as const,toolCallId: "one",toolName: "read",
      output: { type: "json" as const,value: { text: "private tool result",array: [null,true,false,0,-1,1.5] } } }] }],
    tools: [{ type: "function" as const,name: "read",description: "private schema",inputSchema: { type: "object" as const,properties: { toJSON: { type: "string" as const } } } }],
    toolChoice: { type: "auto" as const }, responseFormat: { type: "json" as const,schema: { type: "object" as const } },
    providerOptions: { fixture: { safe: true,context: "private provider context" } }, stopSequences: ["stop"],
  };
  const bytes = Buffer.byteLength(JSON.stringify(envelope));
  expect(inputPayloadBytes({ ...envelope,abortSignal: new AbortController().signal },bytes)).toBe(bytes);
  expect(() => inputPayloadBytes(envelope,bytes-1)).toThrow("payload limit");
});

it("refuses cycles, opaque objects, accessors, unsafe JSON and excessive nesting without copying or disclosing content", () => {
  const cyclic: Record<string,unknown> = {}; cyclic.self = cyclic;
  let getterCalled = false;
  const accessor = Object.defineProperty({},"secret",{ enumerable: true,get: () => { getterCalled = true; return "private-value"; } });
  const customJSON = Object.assign([],{ toJSON: () => { getterCalled = true; return "private-value"; } });
  let deep: unknown = null; for (let i = 0; i < 70; i++) deep = { child: deep };
  for (const value of [cyclic,accessor,customJSON,new Uint8Array(10),new URL("https://example.test/private-value"),BigInt(1),Infinity,() => "private-value",deep]) {
    const params = { prompt: [],providerOptions: { fixture: { value } } } as unknown as ModelParams;
    try { inputPayloadBytes(params,256_000); throw new Error("Input should be rejected."); }
    catch (error) { expect(String(error)).toMatch(/Model input payload/); expect(String(error)).not.toContain("private-value"); }
  }
  expect(getterCalled).toBe(false);
});

it("stops at the bound for huge text and handles shared JSON references and absent fields", () => {
  const shared = { value: "same" },params: ModelParams = { prompt: [],providerOptions: { fixture: { a: shared,b: shared,missing: undefined } } };
  expect(inputPayloadBytes(params,1000)).toBe(Buffer.byteLength(JSON.stringify({ prompt: params.prompt,providerOptions: params.providerOptions })));
  expect(() => inputPayloadBytes({ prompt: [{ role: "system",content: "x".repeat(1_000_000) }] },10)).toThrow("payload limit");
  for (const limit of [0,-1,NaN,1.1,Number.MAX_SAFE_INTEGER+1]) expect(() => inputPayloadBytes(params,limit)).toThrow("budget is invalid");
});
