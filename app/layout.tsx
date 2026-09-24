import type { Metadata } from "next";
import "./globals.css";
import { appConfig } from "@/app.config";
import { AppProviders } from "./_components/app-providers";
import { headers } from "next/headers";

export const metadata: Metadata = {
  title: { default: appConfig.name, template: `%s | ${appConfig.name}` },
  description: appConfig.description,
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html
      lang="en"
      className="h-full antialiased font-sans"
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col"><AppProviders nonce={nonce}>{children}</AppProviders></body>
    </html>
  );
}
