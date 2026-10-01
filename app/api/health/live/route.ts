export function GET() { return Response.json({ status: "alive" }, { headers: { "cache-control": "no-store" } }); }
