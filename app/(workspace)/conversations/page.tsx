import Link from "next/link";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/server";
import { authSettings } from "@/lib/auth/settings";
import { ConversationHistory } from "@/app/_components/conversation-history";
export const metadata = { title: "Conversations" };

export default async function Conversations() {
  await connection();
  const settings = authSettings();
  if (!settings) return <main className="p-8"><h1>Sign-in is not configured</h1><Link href="/account">Account</Link></main>;
  const user = await currentUser();
  if (!user) redirect("/login?next=/conversations");
  return <ConversationHistory key={user.id} settings={settings} runtimeEnabled={process.env.AI_CHAT_ENABLED === "true"} userId={user.id} />;
}
