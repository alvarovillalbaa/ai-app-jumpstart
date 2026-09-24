import { expect, test } from "@playwright/test";
import { auditAccessibility } from "../helpers/accessibility";

const token = "isolated-playwright-token-".repeat(3);
const otherToken = "isolated-playwright-other-".repeat(3);

test("browser uploads stay quarantined, survive a reload, and can be deleted", async ({ page, request }) => {
  const name = `private-${crypto.randomUUID()}.txt`;
  await page.goto("/uploads");
  await expect(page.getByRole("heading", { name: "Private uploads" })).toBeVisible();
  await auditAccessibility(page, "disconnected uploads");
  await page.getByLabel("Access token").fill(token);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("heading", { name: "Stored files" })).toBeVisible();
  await auditAccessibility(page, "connected uploads");

  await page.locator('input[type="file"]').setInputFiles({ name: "invalid.exe", mimeType: "application/octet-stream", buffer: Buffer.from("unsafe") });
  await page.getByRole("button", { name: "Upload to quarantine" }).click();
  await expect(page.getByText("Choose a .txt, .png, .jpg, .jpeg or .pdf file.")).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({ name: "unsafe.txt", mimeType: "text/plain", buffer: Buffer.from("<html>active</html>") });
  await page.getByRole("button", { name: "Upload to quarantine" }).click();
  await expect(page.getByText("Upload filename, type or bytes are invalid.")).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "unsafe.txt" })).toHaveCount(0);

  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from("Private browser upload") });
  await page.getByRole("button", { name: "Upload to quarantine" }).click();
  await expect(page.getByRole("status").filter({ hasText: "is quarantined" })).toBeVisible();
  const row = page.getByRole("listitem").filter({ hasText: name });
  await expect(row).toContainText("unavailable for download or agent use");
  await expect(row.getByRole("link")).toHaveCount(0);
  await auditAccessibility(page, "quarantined uploads");

  const listed = await request.get("/api/v1/uploads", { headers: { authorization: `Bearer ${token}` } });
  expect(listed.status()).toBe(200);
  const id = (await listed.json()).items.find((item: { name: string }) => item.name === name)?.id;
  expect(id).toBeTruthy();
  expect((await request.get(`/api/v1/uploads/${id}`, { headers: { authorization: `Bearer ${token}` } })).status()).toBe(200);
  expect((await request.get(`/api/v1/uploads/${id}`, { headers: { authorization: `Bearer ${otherToken}` } })).status()).toBe(404);
  expect((await request.get("/api/v1/uploads", { headers: { authorization: `Bearer ${otherToken}` } })).ok()).toBeTruthy();
  expect((await request.get(`/api/v1/uploads/${id}/download`, { headers: { authorization: `Bearer ${token}` } })).status()).toBe(404);

  await page.reload();
  await expect(page.getByLabel("Access token")).toHaveValue("");
  await page.getByLabel("Access token").fill(token);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: name })).toBeVisible();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("listitem").filter({ hasText: name }).getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("status").filter({ hasText: "was deleted" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: name })).toHaveCount(0);
  expect((await request.get(`/api/v1/uploads/${id}`, { headers: { authorization: `Bearer ${token}` } })).status()).toBe(404);
});
