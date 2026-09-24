import { z } from "zod";
import { getBudgetStore } from "@/lib/budgets/store";
import { outstandingCursor } from "@/lib/budgets/contract";
import { UsageService } from "@/lib/budgets/usage";
import { chatIdentity } from "@/lib/agent-access/identity";
import { requireChatSettings } from "@/lib/agent-access/settings";
import { handle } from "@/lib/http/handler";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return handle(request,async () => {
    const settings = requireChatSettings();
    const owner = await chatIdentity(request,settings.auth);
    const options = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50),cursor: outstandingCursor.optional() })
      .strict().parse(Object.fromEntries(new URL(request.url).searchParams));
    return Response.json(await new UsageService(getBudgetStore,owner,settings.budget.policy.dailyMicros).listCorrections(options));
  });
}
