import { readFile } from "node:fs/promises";
import { expect,it } from "vitest";

const source = await readFile(new URL("../../.github/workflows/hosted-acceptance.yml",import.meta.url),"utf8");
const stagingJob = source.match(/  staging:\n([\s\S]*?)(?=\n  [a-z][\w-]*:\n|$)/)?.[1];

it("keeps hosted acceptance on the protected staging environment and passes its write acknowledgment",() => {
  expect(stagingJob).toBeDefined();
  expect(stagingJob).toContain("environment: hosted-staging");
  expect(stagingJob).toMatch(/if: github\.ref_type == 'branch' && github\.ref_name == github\.event\.repository\.default_branch/);
  expect(stagingJob).toContain("APP_API_URL: ${{ vars.APP_API_URL }}");
  expect(stagingJob).toContain("APP_SMOKE_TARGET: ${{ vars.APP_SMOKE_TARGET }}");
  expect(stagingJob).toContain("APP_API_TOKEN: ${{ secrets.APP_API_TOKEN }}");
  expect(stagingJob).toContain("APP_API_OTHER_TOKEN: ${{ secrets.APP_API_OTHER_TOKEN }}");
  expect(stagingJob).toContain("npm run smoke:hosted -- --contract --browser");
});
