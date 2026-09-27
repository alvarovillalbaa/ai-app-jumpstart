import assert from "node:assert/strict";

/** @typedef {{email: string,password: string}} BrowserAccount */
/** @typedef {{primary: BrowserAccount,other: BrowserAccount}} AccountBrowserCredentials */

/** Validate before making any request or creating smoke data. Never echo input. */
export function checkedBrowserAccounts(value) {
  const account = input => {
    if (!input || typeof input.email !== "string" || typeof input.password !== "string" ||
        !input.password.length || input.password.length > 1024 || input.email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) {
      throw new Error("Account browser smoke requires two email/password pairs for disposable confirmed accounts.");
    }
    return { email: input.email.trim().toLowerCase(),password: input.password };
  };
  const primary = account(value?.primary),other = account(value?.other);
  if (primary.email === other.email) throw new Error("Account browser smoke requires two distinct accounts.");
  return { primary,other };
}

/** Associate browser credentials with the independently verified API owners. */
export async function verifyBrowserAccounts(accounts,token,otherToken,request) {
  try {
    const ids = [];
    for (const [account,bearer] of [[accounts.primary,token],[accounts.other,otherToken]]) {
      const response = await request("/api/v1/account/profile",{ headers: { authorization: `Bearer ${bearer}` } });
      assert.equal(response.status,200,"Account browser profile verification failed");
      const profile = await response.json();
      assert.ok(typeof profile.id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(profile.id) &&
        typeof profile.email === "string" && profile.email.toLowerCase() === account.email,"Browser credentials do not match the API account");
      ids.push(profile.id);
    }
    assert.notEqual(ids[0],ids[1],"Account browser smoke requires distinct verified owners");
  } catch { throw new Error("Account browser profile verification failed. Check the tokens and their matching disposable accounts."); }
}

/**
 * Actual sign-in and cookie/hydration checks. No injected sessions or model dispatch.
 * @param {{origin: string,protection: Record<string,string>,accounts: AccountBrowserCredentials,title?: string,operationId?: string}} options
 */
export async function accountBrowserRead({ origin,protection,accounts,title,operationId }) {
  const { chromium,expect } = await import("@playwright/test");
  let browser,phase = "launch";
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext(); // No traces, screenshots, video or stored sessions.
    context.setDefaultTimeout(15_000);context.setDefaultNavigationTimeout(20_000);
    if (Object.keys(protection).length) await context.route("**/*",route => new URL(route.request().url()).origin === origin
      ? route.continue({ headers: { ...route.request().headers(),...protection } }) : route.continue());
    const page = await context.newPage();
    const login = async account => {
      await page.goto(`${origin}/login`,{ waitUntil: "domcontentloaded" });
      await page.getByLabel("Email",{ exact: true }).fill(account.email);
      await page.getByLabel("Password",{ exact: true }).fill(account.password);
      await page.getByRole("button",{ name: "Sign in",exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/account");
      await expect(page.getByText(account.email,{ exact: true })).toBeVisible();
    };
    const records = async visible => {
      const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/records" && response.request().method() === "GET");
      await page.getByRole("button",{ name: "Load records",exact: true }).click();
      assert.equal((await response).status(),200,"Account browser record load failed");
      await expect(page.getByRole("button",{ name: "Disconnect",exact: true })).toBeVisible();
      await expect(page.getByRole("heading",{ name: title,exact: true })).toHaveCount(visible ? 1 : 0);
    };
    phase = "owner sign-in";await login(accounts.primary);
    if (title) {
      phase = "owner record read";await records(true);
      phase = "owner record reload";await page.reload({ waitUntil: "domcontentloaded" });await records(true);
    }
    const prompt = "Reply with one short greeting. Do not use tools.";
    if (operationId) {
      phase = "owner chat replay";await page.goto(`${origin}/s/${operationId}`,{ waitUntil: "domcontentloaded" });
      await expect(page.getByPlaceholder("Send a message…")).toBeEnabled({ timeout: 30_000 });
      const log = page.getByRole("log");
      await expect(log.locator(".is-user")).toHaveText(prompt);
      await expect(log.locator(".is-assistant").last()).not.toHaveText("",{ timeout: 30_000 });
      await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
      const before = await log.innerText();
      phase = "owner chat reload";await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByPlaceholder("Send a message…")).toBeEnabled({ timeout: 30_000 });
      await expect(log).toHaveText(before,{ useInnerText: true,timeout: 30_000 });
      await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    }
    phase = "sign-out";await page.goto(`${origin}/account`,{ waitUntil: "domcontentloaded" });
    await page.getByRole("button",{ name: "Sign out",exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/login");
    await page.goto(`${origin}/account`,{ waitUntil: "domcontentloaded" });
    await expect.poll(() => new URL(page.url()).pathname).toBe("/login");
    phase = "other account sign-in";await login(accounts.other);
    if (title) { phase = "other account record denial";await records(false); }
    if (operationId) {
      phase = "other account chat denial";
      const denied = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/conversations/${operationId}` && response.request().method() === "GET");
      await page.goto(`${origin}/s/${operationId}`,{ waitUntil: "domcontentloaded" });
      assert.equal((await denied).status(),404,"Other browser account can resolve the conversation");
      await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
      await expect(page.getByRole("log")).toHaveCount(0);
    }
    phase = "other account sign-out";await page.goto(`${origin}/account`,{ waitUntil: "domcontentloaded" });
    await page.getByRole("button",{ name: "Sign out",exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/login");
  } catch { throw new Error(`Account browser smoke failed at ${phase}. Check the target and disposable account configuration.`); }
  finally { try { await browser?.close(); } catch { throw new Error("Account browser cleanup failed."); } }
}
