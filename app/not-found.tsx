import Link from "next/link";

export default function NotFound() {
  return <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 px-6 py-12">
    <p className="text-sm font-semibold text-muted-foreground">404</p>
    <h1 className="text-3xl font-semibold">Page not found</h1>
    <p className="text-muted-foreground">This page may have moved, or its address may be incorrect.</p>
    <Link href="/records" className="w-fit rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Open records</Link>
  </main>;
}
