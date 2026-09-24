import { expect, test } from "@playwright/test";
import { auditAccessibility } from "../helpers/accessibility";

test("the reference workspace remains accessible across common states", async ({ page }) => {
  await page.goto("/records");
  await auditAccessibility(page, "disconnected records");

  await page.getByLabel("Access token").fill("isolated-playwright-token-".repeat(3));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("button", { name: "Create record" })).toBeVisible();
  await auditAccessibility(page, "connected records");

  await page.getByRole("combobox", { name: "Theme" }).selectOption("dark");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await auditAccessibility(page, "dark records");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("header details summary").click();
  await auditAccessibility(page, "mobile workspace menu");

  await page.goto("/a-page-that-does-not-exist");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await auditAccessibility(page, "not found");
});
