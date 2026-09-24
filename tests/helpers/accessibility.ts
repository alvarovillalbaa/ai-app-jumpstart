import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

export async function auditAccessibility(page: Page, state: string) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map(({ id, nodes }) => ({
    rule: id,
    targets: nodes.map(node => node.target),
  })), state).toEqual([]);
}
