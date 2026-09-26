import Link from "next/link";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/server";
import { chatSettings } from "@/lib/agent-access/settings";
import { ConversationHistory } from "@/app/_components/conversation-history";
export const metadata = { title: "Conversations" };

export default async function Conversations() {
  await connection();
  const settings = chatSettings();
  if (!settings) return <main className="p-8"><h1>Chat is not enabled</h1><Link href="/account">Account</Link></main>;
  const user = await currentUser();
  if (!user) redirect("/login?next=/conversations");
  return <ConversationHistory key={user.id} settings={settings.auth} userId={user.id} />;
}
