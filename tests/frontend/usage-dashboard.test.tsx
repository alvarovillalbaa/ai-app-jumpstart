// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach,expect,it,vi } from "vitest";
import { act,cleanup,fireEvent,render,screen,waitFor } from "@testing-library/react";
import { UsageDashboard } from "../../app/_components/usage-dashboard";

const auth = vi.hoisted(() => ({ listener: (event: string,session: { user: { id: string } } | null) => { void event;void session; } }));
vi.mock("../../lib/auth/browser",() => {
  const client = { auth: {
    onAuthStateChange: (fn: typeof auth.listener) => { auth.listener = fn;return { data: { subscription: { unsubscribe() {} } } }; },
    getSession: async () => ({ data: { session: { user: { id: "alice" },access_token: "current-token" } },error: null }),
  } };
  return { browserAuth: () => client };
});
const settings = { url: "https://identity.example",publishableKey: "sb_publishable_fixture" };
const snapshot = { day: 1,chargedMicros: 5,reservedMicros: 20,active: 1,recent: 2,unknownCosts: 1,dailyLimitMicros: null };
afterEach(() => { cleanup();vi.unstubAllGlobals(); });

it("displays retained charges with chat disabled and no spending progress or allowance",async () => {
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json(snapshot)));
  render(<UsageDashboard settings={settings} userId="alice" />);
  expect(await screen.findByText(/Chat is disabled/)).toHaveTextContent("There is no active spending allowance");
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  expect(screen.getByText("$0.000005")).toBeVisible();expect(screen.getByText("$0.000020")).toBeVisible();
  expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer current-token");
});

it("clears private usage on account change and ignores an outstanding response",async () => {
  let resolve!: (value: Response) => void;
  vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(Response.json(snapshot)).mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; })));
  render(<UsageDashboard settings={settings} userId="alice" />);
  await screen.findByText("$0.000005");fireEvent.click(screen.getByRole("button",{ name: "Refresh" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  act(() => auth.listener("SIGNED_IN",{ user: { id: "bob" } }));
  await act(async () => resolve(Response.json(snapshot)));
  expect(screen.queryByText("$0.000005")).not.toBeInTheDocument();expect(screen.getByRole("alert")).toHaveTextContent("Your account changed");
});

it("preserves a positive allowance and clears stale values when refresh fails",async () => {
  vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(Response.json({ ...snapshot,dailyLimitMicros: 100 }))
    .mockResolvedValueOnce(Response.json({ error: { message: "Usage is unavailable" } },{ status: 503 })));
  render(<UsageDashboard settings={settings} userId="alice" />);
  expect(await screen.findByRole("progressbar")).toHaveAttribute("max","100");
  expect(screen.getByRole("progressbar")).toHaveAttribute("value","25");
  fireEvent.click(screen.getByRole("button",{ name: "Refresh" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Usage is unavailable");
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();expect(screen.queryByText("$0.000005")).not.toBeInTheDocument();
});
