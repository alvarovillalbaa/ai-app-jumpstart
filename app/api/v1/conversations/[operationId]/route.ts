import { chatApplication } from "@/lib/agent-access/application";
import { operationId } from "@/lib/agent-access/contract";
import { chatIdentity } from "@/lib/agent-access/identity";
import { requireChatSettings } from "@/lib/agent-access/settings";
import { handle } from "@/lib/http/handler";
import { conversationHandlers } from "@/lib/http/conversations";

export const runtime = "nodejs";
export async function PATCH(request: Request, context: { params: Promise<{ operationId: string }> }) {
  return conversationHandlers().update(request,(await context.params).operationId);
}
export async function GET(request: Request, context: { params: Promise<{ operationId: string }> }) {
  return handle(request, async () => {
    const settings = requireChatSettings();
    const owner = await chatIdentity(request, settings.auth);
    const id = operationId.parse((await context.params).operationId);
    const { broker } = await chatApplication(settings);
    return Response.json(await broker.read(owner, id));
  });
}
