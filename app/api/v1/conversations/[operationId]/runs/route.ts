import { conversationHandlers } from "@/lib/http/conversations";
export const runtime = "nodejs";
export async function GET(request: Request,context: { params: Promise<{ operationId: string }> }) {
  return conversationHandlers().runs(request,(await context.params).operationId);
}
