import { spawnSync } from "node:child_process";
import { expect,it } from "vitest";

it("refuses hosted or unmarked Convex backends before the browser harness starts",() => {
  const secret = "private-convex-fixture-secret-123456789";
  for (const [url,marker] of [
    ["https://project.convex.site","1"],
    ["http://127.0.0.1:32123/other","1"],
    ["http://127.0.0.1:32123",""],
  ]) {
    const result = spawnSync(process.execPath,["scripts/test-auth.mjs","--convex"],{
      cwd: process.cwd(),encoding: "utf8",timeout: 5000,
      env: { ...process.env,CONVEX_SITE_URL: url,CONVEX_BACKEND_SECRET: secret,TEST_DISPOSABLE_CONVEX: marker },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Convex browser mode requires a disposable loopback backend.");
    expect(result.stderr).not.toContain(secret);
  }
});
