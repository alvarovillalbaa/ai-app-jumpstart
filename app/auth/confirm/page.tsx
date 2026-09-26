import { ConfirmEmail } from "@/app/_components/confirm-email";
import { safeReturnPath } from "@/lib/auth/settings";
export default async function Confirm({ searchParams }: PageProps<"/auth/confirm">) {
  const params = await searchParams;
  if (typeof params.token_hash !== "string" || params.token_hash.length > 2048 || !["email", "recovery"].includes(String(params.type))) return <main className="p-6">This email link is incomplete. Request a new one.</main>;
  return <main><ConfirmEmail tokenHash={params.token_hash} type={params.type as "email" | "recovery"} next={safeReturnPath(params.next)} /></main>;
}
