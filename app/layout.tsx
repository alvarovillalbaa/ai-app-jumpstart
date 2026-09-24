import type { Metadata } from "next";
import "./globals.css";
import { appConfig } from "@/app.config";
import { ThemeProvider } from "next-themes";

export const metadata: Metadata = {
  title: { default: appConfig.name, template: `%s | ${appConfig.name}` },
  description: appConfig.description,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className="h-full antialiased font-sans"
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col"><ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange storageKey="jumpstart-theme">{children}</ThemeProvider></body>
    </html>
  );
}
