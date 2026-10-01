"use client";

import Link from "next/link";

export function RouteError({ retry }: { retry: () => void }) {
  return <main className="mx-auto flex min-h-[50dvh] max-w-lg flex-col justify-center gap-4 px-6 py-12" role="alert">
    <h1 className="text-2xl font-semibold">This page could not load</h1>
    <p className="text-muted-foreground">Please try again. If the problem continues, return to the records page.</p>
    <div className="flex flex-wrap gap-3">
      <button type="button" onClick={retry} className="rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Try again</button>
      <Link href="/records" className="rounded-md border px-4 py-2 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Open records</Link>
    </div>
  </main>;
}
