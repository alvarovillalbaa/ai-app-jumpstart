// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
const mocks = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), signInWithPassword: vi.fn(), signUp: vi.fn(), resetPasswordForEmail: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }) }));
vi.mock("../../lib/auth/browser", () => ({ browserAuth: () => ({ auth: mocks }) }));
import { AuthForm } from "../../app/_components/auth-form";
const settings = { url: "https://identity.example", publishableKey: "sb_publishable_fixture" };
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it("reports rejected login without navigation or provider error leakage", async () => {
  mocks.signInWithPassword.mockResolvedValue({ error: { message: "secret upstream details" } });
  render(<AuthForm mode="login" settings={settings} />);
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.test" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Sign-in failed");
  expect(mocks.replace).not.toHaveBeenCalled(); expect(screen.queryByText(/secret upstream/)).not.toBeInTheDocument();
});
it("requires matching signup passwords and reports pending email confirmation", async () => {
  mocks.signUp.mockResolvedValue({ data: { session: null }, error: null });
  render(<AuthForm mode="signup" settings={settings} />);
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.test" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "strong-test-password" } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "different-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Passwords do not match"); expect(mocks.signUp).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "strong-test-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Check your email"); expect(mocks.replace).not.toHaveBeenCalled();
});
