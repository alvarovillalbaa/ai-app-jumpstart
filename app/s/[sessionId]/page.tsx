import { ChatPage } from "@/app/_components/chat-page";
export const metadata = { title: "Conversation" };

export default async function SessionPage({
  params,
}: {
  readonly params: Promise<{ readonly sessionId: string }>;
}) {
  const { sessionId } = await params;
  return <ChatPage locator={sessionId} />;
}
