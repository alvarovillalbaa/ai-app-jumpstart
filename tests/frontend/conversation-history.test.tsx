// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConversationHistory } from "../../app/_components/conversation-history";

const auth = vi.hoisted(() => ({ listener: (event: string, session: { user: { id: string } } | null) => { void event; void session; }, token: "fresh-token" }));
vi.mock("../../lib/auth/browser", () => {
  const client = { auth: {
    onAuthStateChange: (fn: typeof auth.listener) => { auth.listener = fn; return { data: { subscription: { unsubscribe() {} } } }; },
    getSession: async () => ({ data: { session: { user: { id: "alice" }, access_token: auth.token } }, error: null }),
  } };
  return { browserAuth: () => client };
});
const settings = { url: "https://auth.example", publishableKey: "sb_publishable_fixture" };
const id = "939fb17a-6972-4cf2-99ae-eedbe79174fa";
const item = { id,operationId: id,title: "Private title",createdAt: 0,archived: false,revision: 1,status: "active" };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); auth.token = "fresh-token"; });

it("clears history on account change and ignores an outstanding page",async () => {
  let resolve!: (value: Response) => void;
  vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(Response.json({ items: [item],nextCursor: `0.${id}` }))
    .mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; })));
  render(<ConversationHistory settings={settings} userId="alice" />);
  await screen.findByRole("link",{ name: "Private title" });
  fireEvent.click(screen.getByRole("button",{ name: "Load more" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  act(() => auth.listener("SIGNED_OUT",null));
  await act(async () => resolve(Response.json({ items: [item],nextCursor: null })));
  expect(screen.queryByText("Private title")).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Your account changed");
});

it("ignores an older response after changing the archive filter",async () => {
  let resolve!: (value: Response) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }))
    .mockResolvedValueOnce(Response.json({ items: [{ ...item,archived: true,title: "Archived title" }],nextCursor: null }));
  vi.stubGlobal("fetch",fetcher);
  render(<ConversationHistory settings={settings} userId="alice" />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByLabelText("Show archived"));
  await screen.findByText("Archived title");
  await act(async () => resolve(Response.json({ items: [item],nextCursor: null })));
  expect(screen.queryByText("Private title")).not.toBeInTheDocument();
  expect(screen.getByText("Archived title")).toBeVisible();
});

it("uses a fresh credential and revision, displays conflicts, and preserves the unchanged title",async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ items: [item],nextCursor: null }))
    .mockResolvedValueOnce(Response.json({ error: { message: "This conversation changed. Refresh and try again." } },{ status: 409 }));
  vi.stubGlobal("fetch",fetcher);
  render(<ConversationHistory settings={settings} userId="alice" />);
  await screen.findByText("Private title");
  expect(screen.getByText(/Date unavailable/)).toBeVisible();
  fireEvent.click(screen.getByText("Rename"));
  fireEvent.change(screen.getByLabelText("Title"),{ target: { value: "Replacement" } });
  auth.token = "refreshed-token";
  fireEvent.click(screen.getByText("Save title"));
  await screen.findByRole("alert");
  expect(screen.getByRole("link",{ name: "Private title" })).toHaveAttribute("href",`/s/${id}`);
  expect(screen.queryByRole("link",{ name: "Replacement" })).not.toBeInTheDocument();
  const init = fetcher.mock.calls[1][1] as RequestInit;
  expect(JSON.parse(init.body as string)).toEqual({ revision: 1,title: "Replacement" });
  expect(new Headers(init.headers).get("authorization")).toBe("Bearer refreshed-token");
});

it("appends paginated history and removes a row only after a successful archive",async () => {
  const second = { ...item,id: "539fb17a-6972-4cf2-99ae-eedbe79174fa",operationId: "539fb17a-6972-4cf2-99ae-eedbe79174fa",title: "Older title" };
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ items: [item],nextCursor: `0.${id}` }))
    .mockResolvedValueOnce(Response.json({ items: [second],nextCursor: null }))
    .mockResolvedValueOnce(Response.json({ ...item,revision: 2,archived: true }));
  vi.stubGlobal("fetch",fetcher);
  render(<ConversationHistory settings={settings} userId="alice" />);
  fireEvent.click(await screen.findByRole("button",{ name: "Load more" }));
  await screen.findByText("Older title");
  expect(fetcher.mock.calls[1][0]).toContain(`cursor=0.${id}`);
  fireEvent.click(screen.getAllByText("Archive")[0]);
  await waitFor(() => expect(screen.queryByText("Private title")).not.toBeInTheDocument());
  expect(screen.getByText("Older title")).toBeVisible();
});

it("cancels only a pending start with a fresh credential and keeps it visible as unavailable",async () => {
  const pending = { ...item,status: "starting" };
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ items: [pending],nextCursor: null }))
    .mockResolvedValueOnce(Response.json({ operationId: id,conversationId: id,status: "cancelled" }));
  vi.stubGlobal("fetch",fetcher);
  render(<ConversationHistory settings={settings} userId="alice" />);
  await screen.findByRole("button",{ name: "Cancel pending start" });
  auth.token = "refreshed-token";
  fireEvent.click(screen.getByRole("button",{ name: "Cancel pending start" }));
  await waitFor(() => expect(screen.getByText(/Unavailable/)).toBeVisible());
  expect(screen.queryByRole("button",{ name: "Cancel pending start" })).not.toBeInTheDocument();
  expect(screen.getByText("Private title")).not.toHaveAttribute("href");
  expect(fetcher.mock.calls[1][0]).toBe(`/api/v1/conversations/${id}/cancel-start`);
  expect(fetcher.mock.calls[1][1].method).toBe("POST");
  expect(new Headers(fetcher.mock.calls[1][1].headers).get("authorization")).toBe("Bearer refreshed-token");
});

it("keeps a pending row actionable when cancellation loses the binding race",async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ items: [{ ...item,status: "starting" }],nextCursor: null }))
    .mockResolvedValueOnce(Response.json({ error: { message: "This conversation has started; cancel its active turn instead." } },{ status: 409 }));
  vi.stubGlobal("fetch",fetcher);
  render(<ConversationHistory settings={settings} userId="alice" />);
  fireEvent.click(await screen.findByRole("button",{ name: "Cancel pending start" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("has started");
  expect(screen.getByRole("button",{ name: "Cancel pending start" })).toBeEnabled();
});
