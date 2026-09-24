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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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
