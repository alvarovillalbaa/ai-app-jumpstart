"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef } from "react";
import { appConfig } from "@/app.config";
import { ThemeSelector } from "./theme-selector";

type Features = { chatEnabled: boolean; accountEnabled: boolean; uploadsEnabled?: boolean };

function NavigationLinks({ chatEnabled, accountEnabled, uploadsEnabled, close }: Features & { close?: () => void }) {
  const pathname = usePathname();
  return appConfig.navigation.filter(item => item.feature === "core" ||
    (item.feature === "chat" && chatEnabled) || (item.feature === "auth" && accountEnabled) || (item.feature === "uploads" && uploadsEnabled)).map(item => {
      const active = pathname === item.href || pathname.startsWith(`${item.href}/`) || (item.href === "/s" && pathname === "/");
      return <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} onClick={close}
        className="block rounded-md px-3 py-2 text-sm font-medium text-foreground hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-semibold">
        {item.label}
      </Link>;
    });
}

function MobileMenu({ chatEnabled, accountEnabled, uploadsEnabled }: Features) {
  const menu = useRef<HTMLDetailsElement>(null);
  return <details ref={menu} className="relative">
    <summary className="cursor-pointer rounded-md border px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Menu</summary>
    <nav aria-label="Workspace" className="absolute right-0 z-30 mt-2 w-56 rounded-lg border bg-background p-2 shadow-lg">
      <NavigationLinks chatEnabled={chatEnabled} accountEnabled={accountEnabled} uploadsEnabled={uploadsEnabled} close={() => { if (menu.current) menu.current.open = false; }} />
      <div className="mt-2 border-t pt-2"><ThemeSelector /></div>
    </nav>
  </details>;
}

export function WorkspaceNavigation({ chatEnabled, accountEnabled, uploadsEnabled }: Features) {
  return <>
    <a href="#workspace-content" className="sr-only fixed top-2 left-2 z-50 rounded-md bg-background px-3 py-2 text-foreground shadow-md focus:not-sr-only">Skip to content</a>
    <aside className="hidden border-r bg-sidebar text-sidebar-foreground md:flex md:min-h-dvh md:flex-col md:p-4">
      <Link href="/records" className="mb-6 rounded-md px-3 py-2 font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-ring">{appConfig.name}</Link>
      <nav aria-label="Workspace" className="space-y-1"><NavigationLinks chatEnabled={chatEnabled} accountEnabled={accountEnabled} uploadsEnabled={uploadsEnabled} /></nav>
      <div className="mt-auto border-t pt-3"><ThemeSelector /></div>
    </aside>
    <header className="flex items-center justify-between border-b bg-background px-4 py-3 md:hidden">
      <Link href="/records" className="font-semibold tracking-tight">{appConfig.name}</Link>
      <MobileMenu chatEnabled={chatEnabled} accountEnabled={accountEnabled} uploadsEnabled={uploadsEnabled} />
    </header>
  </>;
}

export function WorkspaceMenu({ chatEnabled, accountEnabled, uploadsEnabled }: Features) {
  return <MobileMenu chatEnabled={chatEnabled} accountEnabled={accountEnabled} uploadsEnabled={uploadsEnabled} />;
}
