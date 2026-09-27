// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach,expect,it,vi } from "vitest";
import { act,cleanup,fireEvent,render,screen,waitFor } from "@testing-library/react";
import { ReviewedUploadPicker,validateChatUpload } from "../../app/_components/reviewed-upload-picker";

const item = { id: "cba8c2d0-e3a2-4395-bc82-392d59c9b6e8",name: "<img onerror=alert(1)>.txt",mediaType: "text/plain",size: 10,
  sha256: "a".repeat(64),createdAt: 1,state: "clean",scan: { status: "clean",sha256: "a".repeat(64),checkedAt: 1,policyVersion: 1 } };
const review = { id: item.id,sha256: item.sha256,revision: 1,status: "approved",approvedAt: 1,checkedAt: 1,policyVersion: 1 };
const reference = { id: item.id,name: item.name,sha256: item.sha256,reviewRevision: 1 };
afterEach(() => { cleanup();vi.unstubAllGlobals(); });

it("loads only eligible metadata, verifies approval and renders the filename as plain text",async () => {
  const changed = vi.fn(),credential = vi.fn(async () => "fresh-token");
  const fetcher = vi.fn<typeof fetch>(async (input,init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fresh-token");
    expect(init?.cache).toBe("no-store");
    return Response.json(String(input).endsWith("/review") ? review : { items: [item,{ ...item,state: "quarantined",scan: undefined },
      { ...item,size: 32769 },{ ...item,mediaType: "application/pdf" }],usage: { files: 4,bytes: 100 } });
  });vi.stubGlobal("fetch",fetcher);
  const view = render(<ReviewedUploadPicker credential={credential} value={null} onChange={changed} disabled={false} />);
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{ name: "Choose reviewed file" }));
  const select = await screen.findByLabelText("File to reference");
  expect(screen.getAllByRole("option")).toHaveLength(2);
  fireEvent.change(select,{ target: { value: item.id } });fireEvent.click(screen.getByRole("button",{ name: "Use file" }));
  await waitFor(() => expect(changed).toHaveBeenCalledWith(reference));
  view.rerender(<ReviewedUploadPicker credential={credential} value={reference} onChange={changed} disabled={false} />);
  expect(screen.getByText(`${item.name} · Review 1`)).toBeVisible();expect(view.container.querySelector("img")).toBeNull();
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/v1/uploads",`/api/v1/uploads/${item.id}/review`]);
  fireEvent.click(screen.getByRole("button",{ name: "Remove file reference" }));expect(changed).toHaveBeenLastCalledWith(null);
});

it("does not select an unapproved file",async () => {
  const changed = vi.fn();vi.stubGlobal("fetch",vi.fn<typeof fetch>(async input => Response.json(String(input).endsWith("/review")
    ? { ...review,status: "unreviewed",revision: 0,approvedAt: null,checkedAt: null }
    : { items: [item],usage: { files: 1,bytes: 10 } })));
  render(<ReviewedUploadPicker credential={async () => "token"} value={null} onChange={changed} disabled={false} />);
  fireEvent.click(screen.getByRole("button",{ name: "Choose reviewed file" }));
  fireEvent.change(await screen.findByLabelText("File to reference"),{ target: { value: item.id } });
  fireEvent.click(screen.getByRole("button",{ name: "Use file" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Approve this file");expect(changed).not.toHaveBeenCalled();
});

it("aborts metadata on unmount and ignores its late response",async () => {
  let resolve!: (response: Response) => void,signal: AbortSignal | undefined;
  const changed = vi.fn();vi.stubGlobal("fetch",vi.fn<typeof fetch>(async (_input,init) => {
    signal = init?.signal ?? undefined;return new Promise<Response>(done => { resolve = done; });
  }));
  const view = render(<ReviewedUploadPicker credential={async () => "token"} value={null} onChange={changed} disabled={false} />);
  fireEvent.click(screen.getByRole("button",{ name: "Choose reviewed file" }));await waitFor(() => expect(signal).toBeDefined());view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => resolve(Response.json({ items: [item],usage: { files: 1,bytes: 10 } })));
  expect(changed).not.toHaveBeenCalled();expect(screen.queryByText(item.name)).not.toBeInTheDocument();
});

it("rejects changed review versions before dispatch without requesting file bytes",async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ...review,revision: 2 }));vi.stubGlobal("fetch",fetcher);
  await expect(validateChatUpload(reference,async () => "token",new AbortController().signal)).rejects.toThrow("file review changed");
  expect(fetcher).toHaveBeenCalledOnce();expect(fetcher.mock.calls[0][0]).toBe(`/api/v1/uploads/${item.id}/review`);
});
