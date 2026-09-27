import { getBudgetStore } from "@/lib/budgets/store";
import { authenticateAccountData as chatIdentity } from "@/lib/http/authenticated-data";
import { requireChatSettings } from "@/lib/agent-access/settings";
import { handle } from "@/lib/http/handler";
import { UsageService } from "@/lib/budgets/usage";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return handle(request, async () => {
    const settings = requireChatSettings();
    const owner = await chatIdentity(request, settings.auth);
    return Response.json(await new UsageService(getBudgetStore,owner,settings.budget.policy.dailyMicros).get());
  });
}
