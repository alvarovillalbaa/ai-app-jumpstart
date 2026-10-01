import { mcpHandler } from "@/lib/mcp";
export const runtime = "nodejs";
export const POST = mcpHandler();
// Stateless request/response transport: there is no GET stream or session to delete.
export function GET() { return new Response(null, { status: 405, headers: { Allow: "POST" } }); }
export const DELETE = GET;
