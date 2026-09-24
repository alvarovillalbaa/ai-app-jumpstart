"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
export function ConfirmEmail({ tokenHash, type, next }: { tokenHash: string; type: "email" | "recovery"; next: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <section className="mx-auto max-w-md space-y-4 p-6"><h1 className="text-2xl font-semibold">{type === "recovery" ? "Reset your password" : "Confirm your email"}</h1><p>Continue to verify this email link.</p><button disabled={busy} className="rounded border px-4 py-2" onClick={async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token_hash: tokenHash, type, next }), signal: AbortSignal.timeout(15_000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "This link could not be verified.");
      router.replace(data.redirectTo); router.refresh();
    } catch (error) { setError(error instanceof Error ? error.message : "Confirmation failed."); }
    finally { setBusy(false); }
  }}>{busy ? "Verifying…" : "Continue"}</button>{error && <p role="alert">{error}</p>}</section>;
}
