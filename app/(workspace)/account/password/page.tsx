import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/server";
import { AuthPage } from "@/app/_components/auth-page";
import { connection } from "next/server";
export const metadata = { title: "Change password" };
export default async function Password() {
  await connection();
  if (!await currentUser()) redirect("/login?next=/account/password");
  return <AuthPage mode="password" />;
}
