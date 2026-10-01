import { afterEach,expect,it,vi } from "vitest";
import { checkedBrowserAccounts,verifyBrowserAccounts } from "../../scripts/helpers/hosted-account-browser.mjs";
import { runHostedSmoke } from "../../scripts/smoke-hosted.mjs";

const credentials = { primary: { email: "alice@example.test",password: "private-primary-password" },other: { email: "bob@example.test",password: "private-other-password" } };
const first = "939fb17a-6972-4cf2-99ae-eedbe79174fa",second = "bf8ae7fb-49b9-44e1-86c4-0c287fe3c6ae";
afterEach(() => { vi.unstubAllGlobals(); });

it("rejects absent, duplicate and malformed account configuration before any request or write",async () => {
  const fetcher = vi.fn();vi.stubGlobal("fetch",fetcher);
  for (const browserAccounts of [undefined,{ ...credentials,other: credentials.primary },{ ...credentials,primary: { ...credentials.primary,email: "bad\naddress" } },
    { ...credentials,primary: { ...credentials.primary,password: "" } }]) {
    await expect(runHostedSmoke({ url: "https://app.example",token: "primary-token",otherToken: "other-token",target: "staging",accounts: true,accountBrowser: true,browserAccounts }))
      .rejects.toThrow(/Account browser smoke/);
  }
  expect(fetcher).not.toHaveBeenCalled();
  expect(checkedBrowserAccounts({ ...credentials,primary: { ...credentials.primary,email: " ALICE@example.test " } }).primary.email).toBe("alice@example.test");
});

it("matches each email to its independently verified token and distinct account ID",async () => {
  const request = vi.fn(async (_path: string,options: { headers: { authorization: string } }) => Response.json(options.headers.authorization === "Bearer first"
    ? { id: first,email: "alice@example.test" } : { id: second,email: "bob@example.test" }));
  await verifyBrowserAccounts(credentials,"first","second",request);
  expect(request.mock.calls.map(([path]) => path)).toEqual(["/api/v1/account/profile","/api/v1/account/profile"]);
  expect(request.mock.calls.map(([,options]) => options.headers.authorization)).toEqual(["Bearer first","Bearer second"]);
});

it("fails closed for a rotated token from the same owner, mismatched email, invalid ID or unavailable profile",async () => {
  for (const profiles of [
    [{ id: first,email: credentials.primary.email },{ id: first,email: credentials.other.email }],
    [{ id: first,email: credentials.other.email }],
    [{ id: "-".repeat(36),email: credentials.primary.email }],
  ]) {
    const request = vi.fn(async () => Response.json(profiles.shift()));
    await expect(verifyBrowserAccounts(credentials,"one","two",request)).rejects.toThrow("profile verification failed");
  }
  await expect(verifyBrowserAccounts(credentials,"one","two",async () => new Response("unauthorized",{ status: 401 }))).rejects.toThrow("profile verification failed");
});

it("does not include credentials or malformed private profile content in failure diagnostics",async () => {
  const secret = credentials.primary.password;
  try {
    await verifyBrowserAccounts(credentials,"one","two",async () => new Response(`broken ${secret} ${credentials.primary.email}`));
    throw new Error("Expected failure");
  } catch (error) {
    expect(String(error)).toContain("profile verification failed");expect(String(error)).not.toContain(secret);expect(String(error)).not.toContain(credentials.primary.email);
  }
});
