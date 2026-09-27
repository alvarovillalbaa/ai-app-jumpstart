import Link from "next/link";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/server";
import { authSettings } from "@/lib/auth/settings";
import { ArtifactLibrary } from "@/app/_components/artifact-library";
export const metadata = { title: "Artifacts" };

export default async function Artifacts() {
  await connection();
  const settings = authSettings();
  if (!settings) return <main className="p-8"><h1>Sign-in is not configured</h1><Link href="/account">Account</Link></main>;
  const user = await currentUser();
  if (!user) redirect("/login?next=/artifacts");
  return <ArtifactLibrary key={user.id} settings={settings} runtimeEnabled={process.env.AI_CHAT_ENABLED === "true"} userId={user.id} />;
}
