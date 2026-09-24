"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { browserAuth } from "@/lib/auth/browser";
import type { PublicAuthSettings } from "@/lib/auth/settings";
import { RecordsPanel } from "./records-panel";

export function AccountPanel({ settings, user }: { settings: PublicAuthSettings; user: { id: string; email: string } }) {
  const router = useRouter();
  const [identity, setIdentity] = useState(user);
  const activeUser = useRef(user.id);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const client = browserAuth(settings);
  useEffect(() => {
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      activeUser.current = session?.user.id ?? "";
      setIdentity({ id: activeUser.current, email: session?.user.email ?? "" });
    });
    return () => { data.subscription.unsubscribe(); activeUser.current = ""; };
  }, [client]);
  async function credential() {
    const expected = identity.id;
    // Reading the client token is permitted here; the server verifies it again.
    const { data, error } = await client.auth.getSession();
    if (error || !data.session || data.session.user.id !== expected || activeUser.current !== expected) throw new Error("Your account changed or your session expired. Sign in again.");
    return data.session.access_token;
  }
  return <main>
    <header className="flex flex-wrap items-center gap-4 border-b p-6">
      <h1 className="w-full text-2xl font-semibold">Account</h1>
      <span>{identity.email || "Signed out"}</span><Link href="/account/password">Change password</Link>
      <button disabled={busy || !identity.id} className="rounded border px-3 py-2" onClick={async () => {
        setBusy(true); setError("");
        try {
          const result = await client.auth.signOut({ scope: "local" });
          if (result.error) throw new Error("Sign-out could not be completed. Try again.");
          activeUser.current = ""; setIdentity({ id: "", email: "" });
          router.replace("/login"); router.refresh();
        } catch (error) { setError(error instanceof Error ? error.message : "Sign-out failed."); }
        finally { setBusy(false); }
      }}>{busy ? "Signing out…" : "Sign out"}</button>
    </header>
    {error && <p role="alert" className="p-6 text-destructive">{error}</p>}
    {identity.id ? <RecordsPanel key={identity.id} credential={credential} headingLevel={2} /> : <p role="status" className="p-6">Your session ended. <Link href="/login">Sign in again</Link>.</p>}
  </main>;
}
