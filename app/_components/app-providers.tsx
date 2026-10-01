"use client";

import { PreferencesProvider } from "./preferences-provider";
import type { PublicAuthSettings } from "@/lib/auth/settings";
import { ThemeProvider } from "next-themes";
import { z } from "zod";

// Zod's production JIT probe uses new Function, which strict CSP forbids.
z.config({ jitless: true });

export function AppProviders({ children, nonce,auth }: { children: React.ReactNode; nonce?: string;auth?: PublicAuthSettings|null }) {
  return <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange storageKey="jumpstart-theme" nonce={nonce}><PreferencesProvider settings={auth}>{children}</PreferencesProvider></ThemeProvider>;
}
