import { expect,it,vi } from "vitest";
import { runUploadCleanup } from "../../scripts/run-upload-cleanup.mjs";

const secret = "s".repeat(40);
const result = (more: boolean,failed = 0) =>
  Response.json({ scanned: 1,deleted: failed ? 0 : 1,skipped: 0,failed,more },{ status: failed ? 503 : 200 });

it("drains bounded cleanup passes using the protected route",async () => {
  const request = vi.fn().mockResolvedValueOnce(result(true)).mockResolvedValueOnce(result(false));
  expect(await runUploadCleanup({ origin: "https://app.example",secret,request })).toEqual({
    batches: 2,scanned: 2,deleted: 2,skipped: 0,failed: 0,
  });
  expect(request).toHaveBeenCalledTimes(2);
  for (const [url,options] of request.mock.calls) {
    expect(url).toBe("https://app.example/api/internal/uploads/cleanup");
    expect(options.headers.authorization).toBe(`Bearer ${secret}`);
    expect(options.redirect).toBe("error");
  }
});

it("fails on endpoint errors, disabled storage and a persistent backlog",async () => {
  const origin = "https://app.example";
  await expect(runUploadCleanup({ origin,secret,request: async () => result(false,1) }))
    .rejects.toThrow("HTTP 503");
  await expect(runUploadCleanup({ origin,secret,request: async () =>
    Response.json({ status: "storage_disabled" }) })).rejects.toThrow("invalid result");
  await expect(runUploadCleanup({ origin,secret,request: async () => result(true),maxBatches: 2 }))
    .rejects.toThrow("backlog remains after 2");
  const request = vi.fn();
  await expect(runUploadCleanup({ origin: "http://app.example",secret,request })).rejects.toThrow("HTTPS origin");
  await expect(runUploadCleanup({ origin,secret: "short",request })).rejects.toThrow("CRON_SECRET");
  expect(request).not.toHaveBeenCalled();
});
