import { readSourceEvents, sourceEventOptions } from "@/lib/agent-access/source-events";
import { chatIdentity } from "@/lib/agent-access/identity";
import { requireChatSettings } from "@/lib/agent-access/settings";
import { getSessionAccessStore } from "@/lib/agent-access/store";
import { bearerToken } from "@/lib/http/auth";
import { handle } from "@/lib/http/handler";

export const runtime = "nodejs";
export async function GET(request: Request,context: { params: Promise<{ operationId: string }> }) {
  return handle(request,async () => {
    const settings = requireChatSettings(),owner = await chatIdentity(request,settings.auth);
    const query = Object.fromEntries(new URL(request.url).searchParams);
    const options = sourceEventOptions.parse({
      ...query,
      ...(query.startIndex === undefined ? {} : { startIndex: Number(query.startIndex) }),
      ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
    });
    return Response.json(await readSourceEvents(await getSessionAccessStore(),owner,(await context.params).operationId,
      options,settings.origin,bearerToken(request),request.signal));
  });
}
