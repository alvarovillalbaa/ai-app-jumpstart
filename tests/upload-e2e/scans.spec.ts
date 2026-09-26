import { expect,test } from "@playwright/test";
import { mkdtemp,readFile,writeFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auditAccessibility } from "../helpers/accessibility";
import { run } from "../../scripts/app-cli";

const token = (label: string) => `upload-scan-fixture-${label}-`.repeat(3);
const headers = { authorization: `Bearer ${token("owner")}` };
const control = process.env.TEST_UPLOAD_SCAN_CONTROL!;
test.beforeEach(async () => { await writeFile(control,"clean"); });

test("browser, REST, CLI and MCP agree on durable clean and rejected upload decisions",async ({ page,request }) => {
  await page.addInitScript(() => {
    const actual = Date.now.bind(Date);
    Date.now = () => actual()+300_000;
  });
  const name = `scan-${crypto.randomUUID()}.txt`,payload = "Private browser scan fixture";
  await page.goto("/uploads");
  await page.getByLabel("Access token").fill(token("owner"));
  await page.getByRole("button",{ name: "Connect" }).click();
  await expect(page.getByRole("heading",{ name: "Stored files" })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({ name,mimeType: "text/plain",buffer: Buffer.from(payload) });
  await page.getByRole("button",{ name: "Upload to quarantine" }).click();
  const row = page.getByRole("listitem").filter({ hasText: name });
  await expect(row).toContainText("Quarantined");
  const listed = await request.get("/api/v1/uploads",{ headers });
  const id = (await listed.json()).items.find((item: { name: string }) => item.name === name).id;
  const url = `/api/v1/uploads/${id}`;
  expect((await request.post(`${url}/scan`,{ headers: { authorization: `Bearer ${token("other")}` },data: {} })).status()).toBe(404);
  expect((await request.post(`${url}/scan`,{ headers: { authorization: `Bearer ${token("metadata")}` },data: {} })).status()).toBe(403);
  expect((await request.post(`${url}/scan`,{ headers,data: { status: "clean" } })).status()).toBe(400);
  await row.getByRole("button",{ name: "Scan file" }).click();
  await expect(row).toContainText("Last scan passed");
  await expect(row).toContainText("Last checked");
  await auditAccessibility(page,"clean upload scan");
  const environment = { APP_API_TOKEN: token("owner"),APP_API_URL: process.env.TEST_UPLOAD_SCAN_ORIGIN };
  expect(await run(["uploads","get",id],environment)).toMatchObject({ id,state: "clean",scan: { status: "clean",policyVersion: 1 } });
  const client = new Client({ name: "browser-scan-contract",version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp",process.env.TEST_UPLOAD_SCAN_ORIGIN),{ requestInit: { headers } }));
    const scanned = await client.callTool({ name: "uploads_scan",arguments: { id } });
    expect(scanned.isError).not.toBe(true);
    expect(JSON.stringify(scanned.content)).not.toContain(payload);
    const linkResult = await client.callTool({ name: "uploads_download_link",arguments: { id } });
    expect(linkResult.isError).not.toBe(true);
    const link = JSON.parse((linkResult.content as { text: string }[])[0].text) as { url: string;expiresAt: number };
    expect(link.url).toMatch(new RegExp(`^${url}/download\\?grant=`));
    expect(link.expiresAt-Date.now()).toBeGreaterThan(0);expect(link.expiresAt-Date.now()).toBeLessThanOrEqual(60_000);
    expect((await request.get(link.url)).status()).toBe(401);
    expect((await request.get(link.url,{ headers: { authorization: `Bearer ${token("other")}` } })).status()).toBe(403);
    expect((await request.get(link.url,{ headers: { authorization: `Bearer ${token("metadata")}` } })).status()).toBe(403);
    const directory = await mkdtemp(join(tmpdir(),"jumpstart-linked-cli-"));
    try {
      const issued = await run(["uploads","link",id],environment);
      const file = join(directory,"link.json"),output = join(directory,"download.txt");
      await writeFile(file,JSON.stringify(issued),{ mode: 0o600 });
      const actual = Date.now;
      try {
        Date.now = () => actual()+300_000;
        expect(await run(["uploads","download-link",file,output],environment)).toMatchObject({ size: payload.length });
      } finally { Date.now = actual; }
      expect(await readFile(output,"utf8")).toBe(payload);
    } finally { await rm(directory,{ recursive: true,force: true }); }
    const downloadPromise = page.waitForEvent("download");
    const downloadRequest = page.waitForRequest(request => request.url().includes(`${url}/download?grant=`));
    await row.getByRole("button",{ name: "Download after scan" }).click();
    expect((await downloadRequest).headers().authorization).toBe(headers.authorization);
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(name);
    expect(await readFile((await download.path())!,"utf8")).toBe(payload);
    await expect(row.getByRole("button",{ name: "Scan again" })).toBeEnabled();
    await writeFile(control,"infected");
    await row.getByRole("button",{ name: "Scan again" }).click();
    await expect(row).toContainText("Rejected · malware scan failed");
    await expect(row.getByRole("button",{ name: "Download after scan" })).toHaveCount(0);
    await expect(row.getByRole("button",{ name: "Scan again" })).toHaveCount(0);
    await expect(page.getByRole("main").getByRole("alert")).toContainText("did not pass malware scanning");
    await auditAccessibility(page,"rejected upload scan");
    await writeFile(control,"clean");
    expect((await request.get(`${url}/download`,{ headers })).status()).toBe(422);
    expect((await request.get(link.url,{ headers })).status()).toBe(422);
    expect((await client.callTool({ name: "uploads_scan",arguments: { id } })).isError).toBe(true);
    expect(await run(["uploads","get",id],environment)).toMatchObject({ state: "rejected",scan: { status: "rejected",reason: "malware" } });
  } finally { await client.close(); }
  await page.reload();
  await page.getByLabel("Access token").fill(token("owner"));
  await page.getByRole("button",{ name: "Connect" }).click();
  await expect(row).toContainText("Rejected · malware scan failed");
  page.once("dialog",dialog => dialog.accept());
  await row.getByRole("button",{ name: "Delete" }).click();
  await expect(row).toHaveCount(0);
  expect((await request.get("/api/v1/uploads",{ headers })).ok()).toBe(true);
  expect((await (await request.get("/api/v1/uploads",{ headers })).json()).usage).toEqual({ files: 0,bytes: 0 });
});

test("a scanner outage never releases bytes based on an earlier clean decision",async ({ page,request }) => {
  const uploaded = await request.post("/api/v1/uploads",{ headers: { ...headers,"content-type": "application/octet-stream",
    "x-upload-name": "outage.txt","x-upload-media-type": "text/plain" },data: Buffer.from("Private outage fixture") });
  expect(uploaded.status()).toBe(201);
  const { id } = await uploaded.json(),url = `/api/v1/uploads/${id}`;
  const scanned = await request.post(`${url}/scan`,{ headers,data: {} });
  expect(scanned.status()).toBe(200);
  const previous = await scanned.json();
  await writeFile(control,"outage");
  const denied = await request.get(`${url}/download`,{ headers });
  expect(denied.status()).toBe(503);
  expect((await denied.json()).error.code).toBe("scanner_unavailable");
  await page.goto("/uploads");
  await page.getByLabel("Access token").fill(token("owner"));
  await page.getByRole("button",{ name: "Connect" }).click();
  const row = page.getByRole("listitem").filter({ hasText: "outage.txt" });
  await row.getByRole("button",{ name: "Scan again" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("scanner is unavailable");
  await expect(row).toContainText("Last scan passed");
  expect((await (await request.get(url,{ headers })).json()).scan).toEqual(previous.scan);
  expect((await request.delete(url,{ headers })).status()).toBe(204);
});
