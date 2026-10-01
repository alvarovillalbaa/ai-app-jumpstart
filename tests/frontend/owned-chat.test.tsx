// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OwnedChat } from "../../app/_components/owned-chat";

const auth = vi.hoisted(() => ({ listener: (event: string, session: { user: { id: string } } | null) => { void event; void session; }, session: { user: { id: "alice" }, access_token: "token-one" } }));
vi.mock("../../lib/auth/browser", () => {
  const client = { auth: {
    onAuthStateChange: (fn: typeof auth.listener) => { auth.listener = fn; return { data: { subscription: { unsubscribe() {} } } }; },
    getSession: async () => ({ data: { session: auth.session }, error: null }),
  } };
  return { browserAuth: () => client };
});
vi.mock("../../app/_components/agent-chat", () => ({ AgentChat: ({ sessionId, onCreate, credential }: { sessionId?: string; onCreate: (text: string) => Promise<void>; credential: () => Promise<string> }) => <div>
  {sessionId ? <p>Private transcript</p> : <button onClick={() => void onCreate("Example")}>Send</button>}
  <button onClick={() => void credential()}>Read fresh credential</button>
</div> }));
const settings = { url: "https://auth.example", publishableKey: "sb_publishable_fixture" };
const id = "939fb17a-6972-4cf2-99ae-eedbe79174fa";
const result = { operationId: id, conversationId: id, status: "active", sessionId: "owned-session" };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); auth.session = { user: { id: "alice" }, access_token: "token-one" }; });

it("unmounts the private transcript immediately when the account changes", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(result)));
  render(<OwnedChat settings={settings} userId="alice" initialOperationId={id} />);
  await screen.findByText("Private transcript");
  act(() => auth.listener("SIGNED_OUT", null));
  expect(screen.queryByText("Private transcript")).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Your account changed");
});

it("does not render a late ownership response after sign-out", async () => {
  let resolve!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
  render(<OwnedChat settings={settings} userId="alice" initialOperationId={id} />);
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  act(() => auth.listener("SIGNED_OUT", null));
  await act(async () => resolve(Response.json(result)));
  expect(screen.queryByText("Private transcript")).not.toBeInTheDocument();
});

it("rechecks an ambiguous creation with a refreshed token and never resends the message", async () => {
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "POST") {
      auth.session = { user: { id: "alice" }, access_token: "token-two" };
      throw new Error("Connection lost after acceptance");
    }
    return Response.json({ ...result, operationId: url.split("/").at(-1) });
  });
  vi.stubGlobal("fetch", fetcher);
  render(<OwnedChat settings={settings} userId="alice" />);
  fireEvent.click(screen.getByText("Send"));
  await screen.findByText("Private transcript");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(new Headers(fetcher.mock.calls[1][1].headers).get("authorization")).toBe("Bearer token-two");
  expect(fetcher.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
});

it("cancels a confirmed pending start without resending its message", async () => {
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => init.method === "POST"
    ? Response.json({ operationId: id,conversationId: id,status: "cancelled" })
    : Response.json({ operationId: id,conversationId: id,status: "starting",sessionId: null }));
  vi.stubGlobal("fetch",fetcher);
  render(<OwnedChat settings={settings} userId="alice" initialOperationId={id} />);
  fireEvent.click(await screen.findByRole("button",{ name: "Cancel pending start" }));
  await screen.findByText("Pending start cancelled");
  expect(window.location.pathname).toBe("/s");
  expect(fetcher.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  expect(fetcher.mock.calls.at(-1)?.[0]).toBe(`/api/v1/conversations/${id}/cancel-start`);
  fireEvent.click(screen.getByRole("button",{ name: "New chat" }));
  expect(screen.getByRole("button",{ name: "Send" })).toBeVisible();
});

it("does not claim cancellation when the runtime won the binding race", async () => {
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => init.method === "POST"
    ? Response.json({ error: { message: "This conversation has started; cancel its active turn instead." } },{ status: 409 })
    : Response.json({ operationId: id,conversationId: id,status: "starting",sessionId: null }));
  vi.stubGlobal("fetch",fetcher);
  render(<OwnedChat settings={settings} userId="alice" initialOperationId={id} />);
  fireEvent.click(await screen.findByRole("button",{ name: "Cancel pending start" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("has started");
  expect(screen.queryByText("Pending start cancelled")).not.toBeInTheDocument();
  expect(screen.getByRole("button",{ name: "Check status" })).toBeEnabled();
});

it("offers cancellation when status is missing but budget admission may have succeeded", async () => {
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => init.method === "POST"
    ? Response.json({ operationId: id,conversationId: id,status: "cancelled" })
    : Response.json({ error: { code: "conversation_not_found",message: "Conversation not found." } },{ status: 404 }));
  vi.stubGlobal("fetch",fetcher);
  render(<OwnedChat settings={settings} userId="alice" initialOperationId={id} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Conversation not found");
  fireEvent.click(screen.getByRole("button",{ name: "Cancel pending start" }));
  await screen.findByText("Pending start cancelled");
});
