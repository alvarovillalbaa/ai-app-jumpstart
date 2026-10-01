import Link from "next/link";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/server";
import { authSettings } from "@/lib/auth/settings";
import { UsageDashboard } from "@/app/_components/usage-dashboard";
export const metadata = { title: "AI usage" };

export default async function UsagePage() {
  await connection();
  const settings = authSettings();
  if (!settings) return <main className="p-8"><h1>Sign-in is not configured</h1><Link href="/account">Account</Link></main>;
  const user = await currentUser();
  if (!user) redirect("/login?next=/usage");
  return <UsageDashboard key={user.id} settings={settings} userId={user.id} />;
}
