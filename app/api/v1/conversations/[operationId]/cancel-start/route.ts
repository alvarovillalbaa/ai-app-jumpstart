import { chatApplication } from "@/lib/agent-access/application";
import { operationId } from "@/lib/agent-access/contract";
import { chatIdentity } from "@/lib/agent-access/identity";
import { requireChatSettings } from "@/lib/agent-access/settings";
import { handle } from "@/lib/http/handler";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ operationId: string }> }) {
  return handle(request, async () => {
    const settings = requireChatSettings();
    const owner = await chatIdentity(request, settings.auth);
    const id = operationId.parse((await context.params).operationId);
    const { cancelStart } = await chatApplication(settings);
    return Response.json(await cancelStart(owner,id));
  });
}
