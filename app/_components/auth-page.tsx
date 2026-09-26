import { authSettings, safeReturnPath } from "@/lib/auth/settings";
import { AuthForm, type AuthMode } from "./auth-form";
import { connection } from "next/server";

export async function AuthPage({ mode, next, error }: { mode: AuthMode; next?: string; error?: string }) {
  await connection();
  const settings = authSettings();
  if (!settings) return <main className="mx-auto max-w-lg space-y-4 p-6"><h1 className="text-2xl font-semibold">Account sign-in is not available</h1><p>Contact the administrator to enable account access. Administrator-issued credentials can still be used on the records screen.</p></main>;
  return <main><AuthForm mode={mode} settings={settings} next={safeReturnPath(next)} initialError={error ? "The confirmation link could not be used. Request a new email or sign in." : ""} /></main>;
}
