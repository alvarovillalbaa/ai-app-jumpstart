// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { afterEach,expect,it,vi } from "vitest";
import { cleanup,render,screen } from "@testing-library/react";
import { AgentMessage } from "../../app/_components/agent-message";
import { encodeReviewedUploadMessage } from "../../lib/uploads/chat-reference";

vi.mock("../../components/ai-elements/message",() => ({
  Message: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MessageContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MessageResponse: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));
const upload = { id: "cba8c2d0-e3a2-4395-bc82-392d59c9b6e8",name: "<b>Private name.txt",sha256: "a".repeat(64),reviewRevision: 1 };
const text = encodeReviewedUploadMessage("Read this source",upload);
afterEach(cleanup);
it("renders only user references as escaped filename chips",() => {
  const view = render(<AgentMessage canRespond={false} isStreaming={false} onInputResponses={() => {}} message={{ id: "user",role: "user",parts: [{ type: "text",text }] }} />);
  expect(screen.getByLabelText("Referenced file")).toHaveTextContent(`${upload.name} · Review 1`);
  expect(screen.getByText("Read this source")).toBeVisible();expect(view.container.querySelector("b")).toBeNull();
  view.rerender(<AgentMessage canRespond={false} isStreaming={false} onInputResponses={() => {}} message={{ id: "assistant",role: "assistant",parts: [{ type: "text",text }] }} />);
  expect(screen.queryByLabelText("Referenced file")).not.toBeInTheDocument();expect(screen.getByText(text)).toBeInTheDocument();
});
it("leaves URL-bearing lookalikes visible as ordinary text",() => {
  const malformed = JSON.stringify({ ...JSON.parse(text),upload: { ...upload,url: "https://foreign.test/file" } });
  render(<AgentMessage canRespond={false} isStreaming={false} onInputResponses={() => {}} message={{ id: "user",role: "user",parts: [{ type: "text",text: malformed }] }} />);
  expect(screen.queryByLabelText("Referenced file")).not.toBeInTheDocument();expect(screen.getByText(malformed)).toBeInTheDocument();
});
