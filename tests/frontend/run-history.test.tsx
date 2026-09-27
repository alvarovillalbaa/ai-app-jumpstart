// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { z } from "zod";
import { runView } from "../../lib/agent-access/run-contract";
import { ActivityTimeline } from "../../app/_components/activity-timeline";

const auth = vi.hoisted(() => ({ listener: (event: string, session: { user: { id: string } } | null) => { void event; void session; },token: "fresh-token" }));
vi.mock("../../lib/auth/browser",() => {
  const client = { auth: {
    onAuthStateChange: (fn: typeof auth.listener) => { auth.listener = fn; return { data: { subscription: { unsubscribe() {} } } }; },
    getSession: async () => ({ data: { session: { user: { id: "alice" },access_token: auth.token } },error: null }),
  } };
  return { browserAuth: () => client };
});
const settings = { url: "https://auth.example",publishableKey: "sb_publishable_fixture" };
const operation = "939fb17a-6972-4cf2-99ae-eedbe79174fa";
const run: z.infer<typeof runView> = { turnId: "private-turn",firstIndex: 1,state: "unverified",startedAt: "2026-09-27T10:00:00.000Z",
  lastBoundaryAt: "2026-09-27T10:00:01.000Z",lastSourceIndex: null,boundarySourceIndex: null,code: null,
  models: ["fixture-model"],boundaryCount: 2,unindexedBoundaries: 2,unindexedFacts: 2,coverage: { checkpoint: 0,indexComplete: true } };
const page = (items = [run],nextCursor: number|null = null) => Response.json({ schemaVersion: 1,source: "eve-run-boundaries",items,nextCursor });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); auth.token = "fresh-token"; });

it("clears run metadata on account change and ignores a delayed page",async () => {
  let resolve!: (value: Response) => void;
  const fetcher = vi.fn().mockResolvedValueOnce(page([run],1))
    .mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
  vi.stubGlobal("fetch",fetcher);
  render(<ActivityTimeline settings={settings} userId="alice" operationId={operation} view="runs" />);
  await screen.findByText("Models: fixture-model");
  fireEvent.click(screen.getByRole("button",{ name: "Load more runs" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  act(() => auth.listener("SIGNED_OUT",null));
  await act(async () => resolve(page([{ ...run,turnId: "late-private-turn" }])));
  expect(screen.queryByText("Models: fixture-model")).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Your account changed");
});

it("verifies saved boundaries with a fresh credential and refreshes the public summary",async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(Response.json({ complete: true }))
    .mockResolvedValueOnce(page([{ ...run,state: "completed",unindexedBoundaries: 0,unindexedFacts: 0,
      lastSourceIndex: 3,boundarySourceIndex: 3,coverage: { checkpoint: 4,indexComplete: true } }]));
  vi.stubGlobal("fetch",fetcher);
  render(<ActivityTimeline settings={settings} userId="alice" operationId={operation} view="runs" />);
  await screen.findByRole("heading",{ name: "Awaiting verification" });
  auth.token = "refreshed-token";
  fireEvent.click(screen.getByRole("button",{ name: "Check history" }));
  await screen.findByRole("heading",{ name: "Run completed" });
  expect(fetcher.mock.calls[1][0]).toBe(`/api/v1/conversations/${operation}/reconcile`);
  expect(fetcher.mock.calls[1][1].method).toBe("POST");
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ resume: true });
  expect(new Headers(fetcher.mock.calls[2][1].headers).get("authorization")).toBe("Bearer refreshed-token");
  expect(fetcher.mock.calls[2][0]).toContain(`/runs?limit=20`);
  expect(screen.queryByText("private-turn")).not.toBeInTheDocument();
});

it("keeps saved runs visible when verification fails and deduplicates paginated rows",async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(page([run],1))
    .mockResolvedValueOnce(Response.json({}, { status: 503 }))
    .mockResolvedValueOnce(page([run,{ ...run,turnId: "second",firstIndex: 2,models: [] }]));
  vi.stubGlobal("fetch",fetcher);
  render(<ActivityTimeline settings={settings} userId="alice" operationId={operation} view="runs" />);
  await screen.findByText("Models: fixture-model");
  fireEvent.click(screen.getByRole("button",{ name: "Check history" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("verification is unavailable");
  expect(screen.getByText("Models: fixture-model")).toBeVisible();
  fireEvent.click(screen.getByRole("button",{ name: "Load more runs" }));
  await screen.findByText("Model information has not been captured.");
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(fetcher.mock.calls[2][0]).toContain("after=1");
});
