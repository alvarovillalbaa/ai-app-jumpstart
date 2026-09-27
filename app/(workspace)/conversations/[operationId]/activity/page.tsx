import Link from "next/link";
import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import { ActivityTimeline } from "@/app/_components/activity-timeline";
import { operationId as operationIdSchema } from "@/lib/agent-access/contract";
import { authSettings } from "@/lib/auth/settings";
import { currentUser } from "@/lib/auth/server";

export const metadata = { title: "Conversation activity" };

export default async function ActivityPage({ params }: { params: Promise<{ operationId: string }> }) {
  await connection();
  const settings = authSettings();
  if (!settings) return <main className="p-8"><h1>Sign-in is not configured</h1><Link href="/account">Account</Link></main>;
  const { operationId } = await params;
  if (!operationIdSchema.safeParse(operationId).success) notFound();
  const user = await currentUser();
  if (!user) redirect("/login?next=/conversations");
  return <ActivityTimeline key={user.id} settings={settings} runtimeEnabled={process.env.AI_CHAT_ENABLED === "true"} userId={user.id} operationId={operationId} />;
}
