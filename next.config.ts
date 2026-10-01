import type { NextConfig } from "next";
import { withEve } from "eve/next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=()" },
  // API and other Next-served responses retain baseline directives. HTML pages
  // get a request nonce and the enforced script/style policy in proxy.ts.
  { key: "Content-Security-Policy", value: "base-uri 'self'; object-src 'none'; frame-ancestors 'none'" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  async rewrites() {
    // withEve owns /eve/*; local Workflow callbacks need the second prefix.
    // Vercel's generated service output owns its own callback routing.
    if (process.env.VERCEL || process.env.NODE_ENV !== "production") return [];
    const origin = process.env.EVE_NEXT_PRODUCTION_ORIGIN
      ? `${new URL(process.env.EVE_NEXT_PRODUCTION_ORIGIN).origin}/_eve_internal/eve`
      : `http://127.0.0.1:${process.env.EVE_NEXT_PRODUCTION_PORT ?? "4274"}`;
    return [{ source: "/.well-known/workflow/:path*", destination: `${origin}/.well-known/workflow/:path*` }];
  },
};

// Mounts the eve agent in ./agent at /eve/v1/* — one dev server, one deploy.
export default withEve(nextConfig);
