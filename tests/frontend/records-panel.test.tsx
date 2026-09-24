// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RecordsPanel } from "../../app/_components/records-panel";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("reports rejected credentials and never shows a successful connection", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { message: "Invalid credential." } }, { status: 401 })));
  render(<RecordsPanel />);
  fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "wrong-token".repeat(5) } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Invalid credential.");
  expect(screen.queryByRole("button", { name: "Create record" })).not.toBeInTheDocument();
});
it("creates records, renders content as text and clears account data on disconnect", async () => {
  const record = { id: "record-1", title: "Example", content: "<script>unsafe()</script>", revision: 1 };
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ items: [], nextCursor: null }))
    .mockResolvedValueOnce(Response.json(record, { status: 201 }))
    .mockResolvedValueOnce(Response.json({ items: [record], nextCursor: null }));
  vi.stubGlobal("fetch", fetchMock);
  render(<RecordsPanel />);
  fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "valid-token".repeat(5) } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Example" } });
  fireEvent.change(screen.getByLabelText("Content"), { target: { value: record.content } });
  fireEvent.click(screen.getByRole("button", { name: "Create record" }));
  expect(await screen.findByText(record.content)).toBeInTheDocument();
  expect(document.querySelector("script")).toBeNull();
  await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  expect(screen.getByLabelText("Access token")).toHaveValue("");
  expect(screen.queryByText(record.content)).not.toBeInTheDocument();
});

it("ignores a late authorization failure from a disconnected account", async () => {
  let rejectOld!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(Response.json({ items: [], nextCursor: null }))
    .mockImplementationOnce(() => new Promise<Response>(resolve => { rejectOld = resolve; }))
    .mockResolvedValueOnce(Response.json({ items: [{ id: "new", title: "New account record", content: "Private", revision: 1 }], nextCursor: null })));
  render(<RecordsPanel />);
  fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "old-account-token".repeat(3) } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "new-account-token".repeat(3) } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await screen.findByText("New account record");
  await act(async () => rejectOld(Response.json({ error: { message: "Old token expired" } }, { status: 401 })));
  expect(screen.getByText("New account record")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
