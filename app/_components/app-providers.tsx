"use client";

import { ThemeProvider } from "next-themes";
import { z } from "zod";

// Zod's production JIT probe uses new Function, which strict CSP forbids.
z.config({ jitless: true });

export function AppProviders({ children, nonce }: { children: React.ReactNode; nonce?: string }) {
  return <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange storageKey="jumpstart-theme" nonce={nonce}>{children}</ThemeProvider>;
}
