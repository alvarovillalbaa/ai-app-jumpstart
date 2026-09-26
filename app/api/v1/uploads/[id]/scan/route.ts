import { uploadHandlers } from "@/lib/http/uploads";
export const runtime = "nodejs";
const handlers = uploadHandlers();
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request,ctx: Context) { return handlers.scan(request,(await ctx.params).id); }
