import { expect, it } from "vitest";
import { browserAuth } from "../../lib/auth/browser";

it("does not reuse browser-client instances across server renders", () => {
  const settings = { url: "https://identity.example", publishableKey: "sb_publishable_fixture" };
  const first = browserAuth(settings);
  const second = browserAuth(settings);
  expect(first).not.toBe(second);
  expect(first.auth).not.toBe(second.auth);
});
