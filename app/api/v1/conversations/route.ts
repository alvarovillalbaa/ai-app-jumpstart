import { chatApplication } from "@/lib/agent-access/application";
import { chatIdentity } from "@/lib/agent-access/identity";
import { requireChatSettings } from "@/lib/agent-access/settings";
import { handle, readJson } from "@/lib/http/handler";
import { conversationHandlers } from "@/lib/http/conversations";

export const runtime = "nodejs";
export const GET = conversationHandlers().list;
export async function POST(request: Request) {
  return handle(request, async () => {
    const settings = requireChatSettings();
    const owner = await chatIdentity(request, settings.auth);
    const input = await readJson(request);
    const { creation } = await chatApplication(settings);
    const result = await creation.create(owner, input);
    return Response.json(result, { status: result.status === "starting" ? 202 : 200 });
  });
}
