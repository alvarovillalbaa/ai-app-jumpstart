import { AuthPage } from "@/app/_components/auth-page";
export const metadata = { title: "Sign in" };
export default async function Login({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  return <AuthPage mode="login" next={typeof params.next === "string" ? params.next : undefined} error={typeof params.error === "string" ? params.error : undefined} />;
}
