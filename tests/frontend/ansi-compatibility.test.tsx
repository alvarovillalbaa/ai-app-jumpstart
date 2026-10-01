// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import Ansi from "ansi-to-react";

afterEach(cleanup);
it("keeps ANSI formatting and escaped text with the patched URL parser", () => {
  const { container } = render(<Ansi>{"\u001b[31mFailure\u001b[0m <script>alert(1)</script>"}</Ansi>);
  expect(screen.getByText("Failure")).toHaveStyle({ color: "rgb(187, 0, 0)" });
  expect(container.textContent).toContain("<script>alert(1)</script>");
  expect(container.querySelector("script")).toBeNull();
});
it("supports ansi-to-react's fuzzy-link API after the scoped dependency override", () => {
  render(<Ansi linkify="fuzzy">{"Read https://example.com/path and example.org. javascript:alert(1)"}</Ansi>);
  expect(screen.getByRole("link", { name: "https://example.com/path" })).toHaveAttribute("href", "https://example.com/path");
  expect(screen.getByRole("link", { name: "example.org" })).toHaveAttribute("href", "http://example.org");
  expect(screen.getAllByRole("link")).toHaveLength(2);
});
