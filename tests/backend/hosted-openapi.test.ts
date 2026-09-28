import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { checkDeployedOpenApi } from "../../scripts/helpers/hosted-openapi.mjs";
import { runHostedSmoke } from "../../scripts/smoke-hosted.mjs";

const document = await readFile(new URL("../../public/openapi.json", import.meta.url));
const id = "00000000-0000-4000-8000-000000000000";
const record = { id,title: "Fixture",content: "Private",revision: 1,
  createdAt: "2026-09-28T19:00:00.000Z",updatedAt: "2026-09-28T19:00:00.000Z" };
afterEach(() => vi.unstubAllGlobals());

it("checks the deployed document before writes and validates actual response status and shape", async () => {
  const verify = await checkDeployedOpenApi(async (path: string) => {
    expect(path).toBe("/openapi.json");
    return new Response(document,{ headers: { "content-type": "application/json" } });
  });
  await verify("/api/v1/records","POST",Response.json(record,{ status: 201 }));
  await verify(`/api/v1/records/creation/${id}`,"GET",Response.json({ status: "created",record }));
  await verify(`/api/v1/records/${id}`,"DELETE",new Response(null,{ status: 204 }));
  await expect(verify("/api/v1/records","POST",Response.json({ ...record,content: 7 },{ status: 201 })))
    .rejects.toThrow("Deployed REST response violates OpenAPI: createRecord 201");
  await expect(verify("/api/v1/records","POST",Response.json(record,{ status: 202 })))
    .rejects.toThrow("Deployed REST success status is absent from OpenAPI: createRecord 202");
});

it("rejects a different deployed contract before a hosted data write", async () => {
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: URL) => {
    requests.push(url.pathname);
    if (url.pathname !== "/openapi.json") throw new Error("Unexpected request after contract mismatch");
    return Response.json({ openapi: "3.1.0",paths: {} });
  }));
  await expect(runHostedSmoke({ url: "https://app.example",token: "primary",otherToken: "other",contract: true }))
    .rejects.toThrow("Deployed OpenAPI document differs from this checkout");
  expect(requests).toEqual(["/openapi.json"]);
});
