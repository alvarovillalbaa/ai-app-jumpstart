import Link from "next/link";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/server";
import { chatSettings } from "@/lib/agent-access/settings";
import { operationId } from "@/lib/agent-access/contract";
import { StructuredForm } from "@/app/_components/structured-form";
export const metadata = { title: "Structured result" };

export default async function StructuredPage({ searchParams }: { searchParams: Promise<{ id?: string;draft?: string }> }) {
  await connection();
  const settings = chatSettings();
  if (!settings) return <main className="p-8"><h1>Structured output is not enabled</h1><Link href="/account">Account</Link></main>;
  const user = await currentUser();
  if (!user) redirect("/login?next=/structured");
  const { id,draft } = await searchParams;
  if (id && !operationId.safeParse(id).success || draft && !operationId.safeParse(draft).success || id && draft)
    return <main className="p-8"><p role="alert">Result not found.</p><Link href="/structured">New result</Link></main>;
  return <StructuredForm key={`${user.id}:${id ?? draft ?? "new"}`} settings={settings.auth} userId={user.id} initialOperationId={id} initialDraftId={draft} />;
}
