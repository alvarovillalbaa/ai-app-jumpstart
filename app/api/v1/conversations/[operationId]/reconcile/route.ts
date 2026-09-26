import { handle, readJson } from "@/lib/http/handler";
import { requireChatSettings } from "@/lib/agent-access/settings";
import { chatIdentity } from "@/lib/agent-access/identity";
import { getSessionAccessStore } from "@/lib/agent-access/store";
import { reconcileProjections } from "@/lib/agent-access/reconcile";

export const runtime = "nodejs";
export async function POST(request: Request,context: { params: Promise<{ operationId: string }> }) {
  return handle(request,async () => {
    const settings = requireChatSettings(), owner = await chatIdentity(request,settings.auth);
    return Response.json(await reconcileProjections(await getSessionAccessStore(),owner,(await context.params).operationId,await readJson(request),settings.origin,request.headers.get("authorization")!.slice(7),request.signal));
  });
}
