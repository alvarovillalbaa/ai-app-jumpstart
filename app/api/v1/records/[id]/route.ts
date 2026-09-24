import { recordHandlers } from "@/lib/http/records";
export const runtime = "nodejs";
const handlers = recordHandlers();
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, ctx: Context) { return handlers.get(request, (await ctx.params).id); }
export async function PATCH(request: Request, ctx: Context) { return handlers.update(request, (await ctx.params).id); }
export async function DELETE(request: Request, ctx: Context) { return handlers.delete(request, (await ctx.params).id); }
