import { randomUUID } from "node:crypto";
import { afterEach,expect,it,vi } from "vitest";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { sqliteBudgetStore } from "../../lib/budgets/sqlite";
import { sqliteRequestLimitStore } from "../../lib/request-limits/sqlite";
import { admitDataRequest } from "../../lib/http/authenticated-data";
import { cancelPendingStart } from "../../lib/agent-access/cancel-start";
import { creationBody,requestHash } from "../../lib/agent-access/signing";
import { AppError } from "../../lib/http/errors";

const { identity,application } = vi.hoisted(() => ({ identity: vi.fn(),application: vi.fn() }));
vi.mock("@/lib/agent-access/identity",() => ({ chatIdentity: identity }));
vi.mock("@/lib/agent-access/settings",() => ({ requireChatSettings: () => ({ auth: {} }) }));
vi.mock("@/lib/agent-access/application",() => ({ chatApplication: application }));
import { POST } from "@/app/api/v1/conversations/[operationId]/cancel-start/route";

afterEach(() => { vi.unstubAllEnvs();vi.clearAllMocks(); });
it("lets a verified owner cancel a pending start with an exhausted quota while retaining auth and ownership",async () => {
  vi.stubEnv("APP_REQUESTS_PER_MINUTE","1");
  const owner = { tenant: randomUUID(),subject: "alice" },id = randomUUID();
  const access = sqliteAccessStore(":memory:"),budgets = sqliteBudgetStore(":memory:"),limits = sqliteRequestLimitStore(":memory:",() => 60001);
  try {
    const hash = requestHash(creationBody({ operationId: id,message: "Pending" }).body);
    await budgets.reserve({ ...owner,operationId: id,requestHash: hash,estimateMicros: 60,
      policy: { id: "fixture",dailyMicros: 100,maxActive: 1,maxPerMinute: 2 },now: Date.now() });
    await access.reserve({ ...owner,id: randomUUID(),operationId: id,requestHash: hash });
    await admitDataRequest(owner,process.env,async () => limits);
    await expect(admitDataRequest(owner,process.env,async () => limits)).rejects.toMatchObject({ status: 429,code: "request_limit" });
    application.mockResolvedValue({ cancelStart: (user: typeof owner,operation: string) => cancelPendingStart(access,budgets,user,operation) });
    const request = () => new Request("http://localhost:3000/api/v1/conversations/"+id+"/cancel-start",{ method: "POST" });
    const context = { params: Promise.resolve({ operationId: id }) };
    identity.mockRejectedValueOnce(new AppError(401,"unauthorized","Authentication required."));
    expect((await POST(request(),context)).status).toBe(401);expect(application).not.toHaveBeenCalled();
    identity.mockResolvedValue({ ...owner,subject: "bob" });
    expect((await POST(request(),context)).status).toBe(404);
    expect((await budgets.snapshot({ ...owner,now: Date.now() })).active).toBe(1);
    identity.mockResolvedValue(owner);
    const response = await POST(request(),context);expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ operationId: id,status: "cancelled" });
    expect(await budgets.snapshot({ ...owner,now: Date.now() })).toMatchObject({ active: 0,reservedMicros: 0,chargedMicros: 0 });
    expect(await access.bind(owner,id,"late-runtime")).toBe(false);
    await expect(admitDataRequest(owner,process.env,async () => limits)).rejects.toMatchObject({ status: 429 });
  } finally { await Promise.all([access.close(),budgets.close(),limits.close()]); }
});
