import Link from "next/link";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/server";
import { chatSettings } from "@/lib/agent-access/settings";
import { UsageDashboard } from "@/app/_components/usage-dashboard";
export const metadata = { title: "AI usage" };

export default async function UsagePage() {
  await connection();
  const settings = chatSettings();
  if (!settings) return <main className="p-8"><h1>Chat is not enabled</h1><Link href="/account">Account</Link></main>;
  const user = await currentUser();
  if (!user) redirect("/login?next=/usage");
  return <UsageDashboard key={user.id} settings={settings.auth} userId={user.id} />;
}
