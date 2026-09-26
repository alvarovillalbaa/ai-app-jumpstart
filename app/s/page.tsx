import { ChatPage } from "@/app/_components/chat-page";
export const metadata = { title: "Chat" };

export default function NewSessionPage() {
  return <ChatPage sessionless />;
}
