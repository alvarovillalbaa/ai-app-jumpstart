import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/server";
import { authSettings } from "@/lib/auth/settings";
import { AccountPanel } from "@/app/_components/account-panel";
import { connection } from "next/server";
export const metadata = { title: "Account" };
export default async function Account() {
  await connection();
  const settings = authSettings();
  const user = await currentUser();
  if (!settings || !user) redirect("/login?next=/account");
  return <AccountPanel settings={settings} user={user} />;
}
