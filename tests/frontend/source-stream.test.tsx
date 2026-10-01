// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { sourceEventPage } from "../../lib/agent-access/source-contract";
import { ActivityTimeline } from "../../app/_components/activity-timeline";

const auth = vi.hoisted(() => ({ listener: (event: string, session: { user: { id: string } } | null) => { void event; void session; }, token: "fresh-token" }));
vi.mock("../../lib/auth/browser", () => {
  const client = { auth: {
    onAuthStateChange: (fn: typeof auth.listener) => { auth.listener = fn; return { data: { subscription: { unsubscribe() {} } } }; },
    getSession: async () => ({ data: { session: { user: { id: "alice" }, access_token: auth.token } }, error: null }),
  } };
  return { browserAuth: () => client };
});

const settings = { url: "https://auth.example", publishableKey: "sb_publishable_fixture" };
const operation = "939fb17a-6972-4cf2-99ae-eedbe79174fa";
const entry = (sourceIndex: number, text: string) => ({ schemaVersion: 1 as const, eventId: `evt_${String(sourceIndex).padStart(26, "0")}`, at: "2026-09-27T10:00:00.000Z",
  turnId: "private-turn", sequence: sourceIndex, payload: { kind: "message" as const, role: "assistant" as const, parts: [{ type: "text" as const, text }] }, sourceIndex });
const page = (items: Array<ReturnType<typeof entry>>, scanned: number, nextIndex: number, complete: boolean) =>
  Response.json(sourceEventPage.parse({ schemaVersion: 1, source: "eve-durable-stream", items, scanned, nextIndex, complete }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); auth.token = "fresh-token"; });

it("renders selected source events in source order without dispatching or reconciling a turn", async () => {
  const fetcher = vi.fn().mockResolvedValue(page([entry(7, "Selected source answer")], 8, 8, true));
  vi.stubGlobal("fetch", fetcher);
  render(<ActivityTimeline settings={settings} userId="alice" operationId={operation} view="source" />);

  await screen.findByText("Selected source answer");
  expect(screen.getByText(/Source #7/)).toBeInTheDocument();
  expect(screen.getByText(/not canonical model history/)).toBeInTheDocument();
  expect(screen.getByText(/Reached the source stream tail observed/)).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe(`/api/v1/conversations/${operation}/source-events?startIndex=0&limit=20`);
  expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
  expect(new Headers(fetcher.mock.calls[0][1].headers).get("authorization")).toBe("Bearer fresh-token");
  expect(fetcher.mock.calls[0][1].method).toBeUndefined();
  expect(screen.queryByRole("button", { name: "Check history" })).not.toBeInTheDocument();
});

it("advances by scanned source positions when a page contains no selected events", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(page([], 250, 250, false))
    .mockResolvedValueOnce(page([entry(250, "Event after filtered entries")], 1, 251, true));
  vi.stubGlobal("fetch", fetcher);
  render(<ActivityTimeline settings={settings} userId="alice" operationId={operation} view="source" />);

  await screen.findByRole("button", { name: "Load more source events" });
  expect(screen.getByText(/This scanned page had no displayable events/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Load more source events" }));
  await screen.findByText("Event after filtered entries");
  expect(fetcher.mock.calls[1][0]).toContain("startIndex=250");
  expect(screen.getByText(/Reached the source stream tail observed/)).toBeInTheDocument();
});

it("clears source events on account change and ignores a delayed page", async () => {
  let resolve!: (value: Response) => void;
  const fetcher = vi.fn().mockResolvedValueOnce(page([entry(0, "Visible source event")], 1, 1, false))
    .mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
  vi.stubGlobal("fetch", fetcher);
  render(<ActivityTimeline settings={settings} userId="alice" operationId={operation} view="source" />);
  await screen.findByText("Visible source event");
  fireEvent.click(screen.getByRole("button", { name: "Load more source events" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

  act(() => auth.listener("SIGNED_OUT", null));
  await act(async () => resolve(page([entry(1, "Late private source event")], 1, 2, false)));
  expect(screen.queryByText("Visible source event")).not.toBeInTheDocument();
  expect(screen.queryByText("Late private source event")).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Your account changed");
});

it("does not read the source stream when account chat is disabled", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  render(<ActivityTimeline settings={settings} userId="alice" operationId={operation} view="source" runtimeEnabled={false} />);

  expect(await screen.findByText("Source stream reading requires enabled account chat.")).toBeInTheDocument();
  expect(fetcher).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Refresh source stream" })).toBeDisabled();
});
