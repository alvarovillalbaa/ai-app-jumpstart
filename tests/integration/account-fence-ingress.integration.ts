import { randomUUID } from "node:crypto";
import { expect,it } from "vitest";
import { createSessionAccessStore } from "../../lib/agent-access/store";
import { createUploadCatalog } from "../../lib/uploads/catalog-store";
import { admitDataRequest } from "../../lib/http/authenticated-data";
import { setPostgresAccountFence } from "../../scripts/fence-account-writes";

it("reads the exact permanent PostgreSQL fence through the selected runtime adapter",async () => {
  const owner = { tenant: `ingress-${randomUUID()}`,subject: randomUUID() };
  const other = { ...owner,subject: randomUUID() };
  const store = await createSessionAccessStore(),uploads = await createUploadCatalog();
  try {
    expect(await store.isFenced(owner)).toBe(false);
    expect(await uploads.isFenced(owner)).toBe(false);
    await admitDataRequest(owner,{ APP_REQUESTS_PER_MINUTE: "0" },async () => { throw new Error("quota store should stay unused"); },async () => store);
    await setPostgresAccountFence(process.env.DATABASE_URL!,owner);
    expect(await store.isFenced(owner)).toBe(true);
    expect(await uploads.isFenced(owner)).toBe(true);
    await expect(admitDataRequest(owner,{ APP_REQUESTS_PER_MINUTE: "0" },async () => { throw new Error("quota store should stay unused"); },async () => store))
      .rejects.toMatchObject({ status: 403,code: "account_fenced" });
    await admitDataRequest(other,{ APP_REQUESTS_PER_MINUTE: "0" },async () => { throw new Error("quota store should stay unused"); },async () => store);
    expect(await store.isFenced(other)).toBe(false);
    expect(await uploads.isFenced(other)).toBe(false);
  } finally { await store.close();await uploads.close(); }
});
