import Link from "next/link";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/server";
import { chatSettings } from "@/lib/agent-access/settings";
import { operationId } from "@/lib/agent-access/contract";
import { AgentChat } from "./agent-chat";
import { OwnedChat } from "./owned-chat";

export async function ChatPage({ locator, sessionless = false }: { locator?: string; sessionless?: boolean }) {
  await connection();
  const settings = chatSettings();
  const uploadsEnabled = ["local", "supabase"].includes(process.env.UPLOAD_STORAGE_PROVIDER ?? "");
  if (!settings) {
    if (process.env.NODE_ENV === "development") return <AgentChat sessionId={locator} sessionless={sessionless} uploadsEnabled={uploadsEnabled} />;
    return <main className="p-8"><h1 className="text-2xl font-medium">Chat is not enabled</h1><p>This deployment has not enabled account chat.</p><Link href="/account">Account</Link></main>;
  }
  const user = await currentUser();
  if (!user) redirect("/login?next=/s");
  if (locator && !operationId.safeParse(locator).success) return <main className="p-8"><p role="alert">Conversation not found.</p><Link href="/s">New chat</Link></main>;
  return <OwnedChat key={`${user.id}:${locator ?? "new"}`} settings={settings.auth} userId={user.id} initialOperationId={locator} uploadsEnabled={uploadsEnabled} />;
}
