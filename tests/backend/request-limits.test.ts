import { expect,it } from "vitest";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteRequestLimitStore } from "../../lib/request-limits/sqlite";
import { requestsPerMinute } from "../../lib/request-limits/settings";
import { requestLimitContract } from "../contracts/request-limits";

requestLimitContract("SQLite",async () => sqliteRequestLimitStore(":memory:"));
it("opens a new window at the exact boundary and never refills on a backwards clock",async () => {
  let now = 600000;
  const store = sqliteRequestLimitStore(":memory:",() => now),owner = { tenant: "org",subject: "alice" };
  try {
    expect((await store.claim(owner,1)).allowed).toBe(true);
    now = 659999;expect(await store.claim(owner,1)).toMatchObject({ allowed: false,retryAfterSeconds: 1 });
    now = 660000;expect(await store.claim(owner,1)).toMatchObject({ allowed: true,remaining: 0,resetAt: new Date(720000).toISOString() });
    now = 600000;expect((await store.claim(owner,1)).allowed).toBe(false);
    now = 720000;expect((await store.claim(owner,1)).allowed).toBe(true);
  } finally { await store.close(); }
});
it("shares claims between connections and retains them after reopening",async () => {
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-limits-")),path = join(directory,"app.sqlite"),owner = { tenant: "org",subject: "alice" };
  const a = sqliteRequestLimitStore(path,() => 600000),b = sqliteRequestLimitStore(path,() => 600000);
  try { expect((await Promise.all(Array.from({ length: 30 },(_,index) => (index%2 ? a : b).claim(owner,4)))).filter(row => row.allowed)).toHaveLength(4); }
  finally { await a.close();await b.close(); }
  const reopened = sqliteRequestLimitStore(path,() => 600000);
  try { expect((await reopened.claim(owner,4)).allowed).toBe(false); }
  finally { await reopened.close();await rm(directory,{ recursive: true,force: true }); }
});
it("accepts explicit disabled/enabled settings and rejects ambiguous or unsafe values",() => {
  expect(requestsPerMinute({})).toBe(0);expect(requestsPerMinute({ APP_REQUESTS_PER_MINUTE: "0" })).toBe(0);
  expect(requestsPerMinute({ APP_REQUESTS_PER_MINUTE: "120" })).toBe(120);
  for (const value of [""," ","01","1.5","-1","10001","1e2"]) expect(() => requestsPerMinute({ APP_REQUESTS_PER_MINUTE: value })).toThrow("APP_REQUESTS_PER_MINUTE");
});
