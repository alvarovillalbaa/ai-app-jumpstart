import { describe,expect,it,vi } from "vitest";
import { runHostedSmoke,verifyHostedModelReceipt } from "../../scripts/smoke-hosted.mjs";

const operationId = "01234567-89ab-4cde-8fab-0123456789ab";
const expectedModel = "openai/gpt-5.6-luna-fast";
const sourceModels = new Set([expectedModel]);

describe("hosted model receipt",() => {
  it("binds an exact source model to the settled owner cost across reservation pages",async () => {
    const request = vi.fn(async (path: string,options: { headers: Record<string,string> }) => {
      expect(options.headers.authorization).toBe("Bearer owner-token");
      if (!path.includes("cursor=")) return Response.json({ items: [{ operationId: crypto.randomUUID(),status: "settled",actualMicros: 1 }],nextCursor: "next" });
      return Response.json({ items: [{ operationId,status: "settled",actualMicros: 27 }],nextCursor: null });
    });
    await expect(verifyHostedModelReceipt({ request,token: "owner-token",operationId,sourceModels,
      expectedModel,maxObservedMicros: 30 })).resolves.toEqual({ modelId: expectedModel,actualMicros: 27 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([null,0,31])("rejects unknown, zero or excessive observed cost (%s)",async actualMicros => {
    const request = vi.fn(async () => Response.json({ items: [{ operationId,status: "settled",actualMicros }],nextCursor: null }));
    await expect(verifyHostedModelReceipt({ request,token: "owner-token",operationId,sourceModels,
      expectedModel,maxObservedMicros: 30 })).rejects.toThrow(/unknown or zero|exceeded/);
  });

  it("waits for the same operation to settle without dispatching another turn",async () => {
    let reads = 0;
    const request = vi.fn(async () => Response.json({ items: [{ operationId,
      status: ++reads === 1 ? "reserved" : "settled",actualMicros: reads === 1 ? null : 19 }],nextCursor: null }));
    await expect(verifyHostedModelReceipt({ request,token: "owner-token",operationId,sourceModels,
      expectedModel,maxObservedMicros: 30 })).resolves.toEqual({ modelId: expectedModel,actualMicros: 19 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects a different or missing model before reading the cost ledger",async () => {
    const request = vi.fn();
    await expect(verifyHostedModelReceipt({ request,token: "owner-token",operationId,
      sourceModels: new Set(["fixture-model"]),expectedModel,maxObservedMicros: 30 })).rejects.toThrow("expected model");
    await expect(verifyHostedModelReceipt({ request,token: "owner-token",operationId,
      sourceModels: new Set(),expectedModel,maxObservedMicros: 30 })).rejects.toThrow("expected model");
    expect(request).not.toHaveBeenCalled();
  });

  it("requires explicit agent mode and valid cost settings before contacting the deployment",async () => {
    const base = { url: "https://staging.example",token: "owner-token",otherToken: "foreign-token",
      accounts: true,modelReceipt: { expectedModel,maxObservedMicros: 30 } };
    await expect(runHostedSmoke(base)).rejects.toThrow("explicit agent turn");
    await expect(runHostedSmoke({ ...base,agent: true,modelReceipt: { expectedModel,maxObservedMicros: Number.NaN } }))
      .rejects.toThrow("positive integer");
    await expect(runHostedSmoke({ ...base,agent: true,agentFollowUp: true })).rejects.toThrow("separately");
    await expect(runHostedSmoke({ url: base.url,token: base.token,otherToken: base.otherToken,agentFollowUp: true }))
      .rejects.toThrow("explicit agent turn");
  });
});
