"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { browserAuth } from "@/lib/auth/browser";
import type { PublicAuthSettings } from "@/lib/auth/settings";

export type AuthMode = "login" | "signup" | "recover" | "password";
const labels = { login: "Sign in", signup: "Create account", recover: "Reset password", password: "Update password" };
export function AuthForm({ mode, settings, next = "/account", initialError = "" }: { mode: AuthMode; settings: PublicAuthSettings; next?: string; initialError?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(initialError);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError(""); setMessage("");
    if (["signup", "password"].includes(mode) && password !== confirmation) { setError("Passwords do not match."); return; }
    setBusy(true);
    try {
      const client = browserAuth(settings);
      const callback = `${window.location.origin}/auth/callback`;
      if (mode === "login") {
        const result = await client.auth.signInWithPassword({ email, password });
        if (result.error) throw new Error("Sign-in failed. Check your credentials and confirm your email.");
        router.replace(next); router.refresh();
      } else if (mode === "signup") {
        const result = await client.auth.signUp({ email, password, options: { emailRedirectTo: `${callback}?next=/account` } });
        if (result.error) throw new Error("We could not create the account. Check the details or try again later.");
        if (result.data.session) { router.replace("/account"); router.refresh(); }
        else setMessage("Check your email to confirm your account before signing in.");
      } else if (mode === "recover") {
        const result = await client.auth.resetPasswordForEmail(email, { redirectTo: `${callback}?next=/account/password` });
        if (result.error) throw new Error("We could not send the recovery email. Try again later.");
        setMessage("If this account exists, a password reset email is on its way.");
      } else {
        const verified = await client.auth.getUser();
        if (verified.error || !verified.data.user) throw new Error("Your session expired. Request another password reset email.");
        const result = await client.auth.updateUser({ password });
        if (result.error) throw new Error("The password could not be updated. Try again or request a new reset email.");
        setMessage("Your password has been updated.");
      }
      setPassword(""); setConfirmation("");
    } catch (error) { setError(error instanceof Error ? error.message : "Sign-in is temporarily unavailable."); }
    finally { setBusy(false); }
  }
  const field = "mt-1 w-full rounded border bg-background p-3";
  return <section className="mx-auto w-full max-w-md space-y-6 p-6">
    <h1 className="text-2xl font-semibold">{labels[mode]}</h1>
    <form onSubmit={submit} className="space-y-4">
      {mode !== "password" && <label className="block">Email<input className={field} type="email" autoComplete="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} /></label>}
      {mode !== "recover" && <label className="block">Password<input className={field} type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={mode === "login" ? 1 : 12} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} /></label>}
      {["signup", "password"].includes(mode) && <><p className="text-sm text-muted-foreground">Use at least 12 characters.</p><label className="block">Confirm password<input className={field} type="password" autoComplete="new-password" required value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label></>}
      <button className="rounded border px-4 py-2 disabled:opacity-50" disabled={busy} type="submit">{busy ? "Working…" : labels[mode]}</button>
    </form>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {message && <p role="status">{message}</p>}
    <nav className="flex flex-wrap gap-4 text-sm"><Link href="/login">Sign in</Link><Link href="/signup">Create account</Link><Link href="/recover">Forgot password?</Link><Link href="/records">API credentials</Link></nav>
  </section>;
}
