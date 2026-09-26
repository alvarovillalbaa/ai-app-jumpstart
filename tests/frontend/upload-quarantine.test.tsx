// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UploadQuarantine } from "../../app/_components/upload-quarantine";

const auth = vi.hoisted(() => ({ listener: (_event: string, _session: { user: { id: string } } | null) => { void _event; void _session; } }));
vi.mock("../../lib/auth/browser", () => {
  const client = { auth: {
    onAuthStateChange: (fn: typeof auth.listener) => { auth.listener = fn; return { data: { subscription: { unsubscribe() {} } } }; },
    getSession: async () => ({ data: { session: { user: { id: "alice" }, access_token: "fresh-token" } }, error: null }),
  } };
  return { browserAuth: () => client };
});

const settings = { url: "https://auth.example", publishableKey: "sb_publishable_fixture" };
const item = {
  id: "cba8c2d0-e3a2-4395-bc82-392d59c9b6e8", name: "Private file.txt", mediaType: "text/plain", size: 10,
  sha256: "a".repeat(64), createdAt: Date.now(), state: "quarantined",
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("refreshes durable clean and rejected decisions after an authenticated scan",async () => {
  let row = { ...item } as Record<string,unknown>;
  let infected = false;
  vi.stubGlobal("fetch",vi.fn<typeof fetch>(async (input,init) => {
    if (String(input).endsWith("/scan")) {
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe("{}");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fresh-token");
      row = { ...item,state: infected ? "rejected" : "clean",scan: {
        sha256: item.sha256,status: infected ? "rejected" : "clean",checkedAt: Date.now(),policyVersion: 1,
        ...(infected ? { reason: "malware" } : {}),
      } };
      return infected ? Response.json({ error: { message: "Upload did not pass malware scanning." } },{ status: 422 }) : Response.json(row);
    }
    return Response.json({ items: [row],usage: { files: 1,bytes: item.size } });
  }));
  const view = render(<UploadQuarantine settings={settings} userId="alice" downloadEnabled />);
  fireEvent.click(await screen.findByRole("button",{ name: "Scan file" }));
  await screen.findByText(/Last scan passed/);
  expect(screen.getByText(/Last checked/)).toBeVisible();
  await waitFor(() => expect(screen.getByRole("button",{ name: "Scan again" })).toBeEnabled());
  infected = true;
  fireEvent.click(screen.getByRole("button",{ name: "Scan again" }));
  await screen.findByText(/Rejected · malware scan failed/);
  expect(screen.queryByRole("button",{ name: "Download after scan" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button",{ name: "Scan again" })).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button",{ name: "Delete" })).toBeEnabled());
  expect(screen.getByRole("alert")).toHaveTextContent("did not pass malware");
  view.unmount();
  render(<UploadQuarantine settings={settings} userId="alice" downloadEnabled />);
  await screen.findByText(/Rejected · malware scan failed/);
});

it("aborts a scan on account change and ignores its late verdict",async () => {
  let resolveScan: ((response: Response) => void) | undefined;
  let signal: AbortSignal | undefined;
  vi.stubGlobal("fetch",vi.fn<typeof fetch>(async (input,init) => {
    if (String(input).endsWith("/scan")) {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(resolve => { resolveScan = resolve; });
    }
    return Response.json({ items: [item],usage: { files: 1,bytes: item.size } });
  }));
  render(<UploadQuarantine settings={settings} userId="alice" downloadEnabled />);
  fireEvent.click(await screen.findByRole("button",{ name: "Scan file" }));
  await waitFor(() => expect(signal).toBeDefined());
  act(() => auth.listener("SIGNED_OUT",null));
  expect(signal?.aborted).toBe(true);
  await act(async () => resolveScan?.(Response.json({ ...item,state: "clean",scan: {
    status: "clean",sha256: item.sha256,checkedAt: Date.now(),policyVersion: 1,
  } })));
  expect(screen.getByRole("alert")).toHaveTextContent("Your account changed");
  expect(screen.queryByText(item.name)).not.toBeInTheDocument();
  expect(screen.queryByText(/Last scan passed/)).not.toBeInTheDocument();
});

it("aborts an in-flight upload and clears another account's filenames on sign-out", async () => {
  const abort = vi.fn();
  const send = vi.fn();
  class PendingUpload {
    upload = { onprogress: (_event: ProgressEvent) => { void _event; } };
    open() {}
    setRequestHeader() {}
    send = send;
    abort = abort;
    timeout = 0;
  }
  vi.stubGlobal("XMLHttpRequest", PendingUpload);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ items: [item], usage: { files: 1, bytes: 10 } })));
  render(<UploadQuarantine settings={settings} userId="alice" />);
  await screen.findByText("Private file.txt");
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(["valid text"], "new.txt", { type: "text/plain" })] } });
  fireEvent.click(screen.getByRole("button", { name: "Upload to quarantine" }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  act(() => auth.listener("SIGNED_OUT", null));
  expect(abort).toHaveBeenCalledOnce();
  expect(screen.queryByText("Private file.txt")).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Your account changed");
});

it("offers a scanned owner download and saves only the returned private bytes",async () => {
  const payload = "owner text";
  const create = vi.fn(() => "blob:private-upload");
  const revoke = vi.fn();
  const click = vi.spyOn(HTMLAnchorElement.prototype,"click").mockImplementation(() => {});
  vi.stubGlobal("URL",class extends URL { static createObjectURL = create;static revokeObjectURL = revoke; });
  const fetcher = vi.fn<typeof fetch>(async (input,init) => {
    if (String(input).endsWith("/download")) {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fresh-token");
      return new Response(payload,{ headers: { "content-type": "application/octet-stream" } });
    }
    return Response.json({ items: [{ ...item,size: payload.length }],usage: { files: 1,bytes: payload.length } });
  });
  vi.stubGlobal("fetch",fetcher);
  render(<UploadQuarantine settings={settings} userId="alice" downloadEnabled />);
  await screen.findByRole("button",{ name: "Download after scan" });
  fireEvent.click(screen.getByRole("button",{ name: "Download after scan" }));
  await waitFor(() => expect(click).toHaveBeenCalledOnce());
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ size: payload.length }));
  expect(screen.getByRole("status")).toHaveTextContent("passed a fresh scan");
});

it("cancels an in-flight download when the account changes",async () => {
  let resolveDownload: ((response: Response) => void) | undefined;
  let downloadSignal: AbortSignal | undefined;
  const click = vi.spyOn(HTMLAnchorElement.prototype,"click").mockImplementation(() => {});
  vi.stubGlobal("fetch",vi.fn<typeof fetch>(async (input,init) => {
    if (String(input).endsWith("/download")) {
      downloadSignal = init?.signal ?? undefined;
      return new Promise<Response>(resolve => { resolveDownload = resolve; });
    }
    return Response.json({ items: [item],usage: { files: 1,bytes: item.size } });
  }));
  render(<UploadQuarantine settings={settings} userId="alice" downloadEnabled />);
  fireEvent.click(await screen.findByRole("button",{ name: "Download after scan" }));
  await waitFor(() => expect(downloadSignal).toBeDefined());
  act(() => auth.listener("SIGNED_OUT",null));
  expect(downloadSignal?.aborted).toBe(true);
  resolveDownload?.(new Response("owner text",{ headers: { "content-type": "application/octet-stream" } }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Your account changed"));
  expect(click).not.toHaveBeenCalled();
});
