import { z } from "zod";
import { requireAuthSettings } from "../auth/settings";
import { chatSettings } from "../agent-access/settings";
import { getBudgetStore } from "../budgets/store";
import { UsageService } from "../budgets/usage";
import { outstandingCursor,type BudgetStore } from "../budgets/contract";
import { authenticateAccountData } from "./authenticated-data";
import { handle } from "./handler";

/** Retained ledger reads need account authority, not permission to dispatch AI. */
export function usageHandlers(store: () => Promise<BudgetStore> = getBudgetStore) {
  async function service(request: Request,current = false) {
    const owner = await authenticateAccountData(request,requireAuthSettings());
    const limit = current ? chatSettings()?.budget.policy.dailyMicros ?? null : null;
    return new UsageService(store,owner,limit);
  }
  function options(request: Request) {
    return z.object({ limit: z.coerce.number().int().min(1).max(100).default(50),cursor: outstandingCursor.optional() })
      .strict().parse(Object.fromEntries(new URL(request.url).searchParams));
  }
  return {
    current: (request: Request) => handle(request,async () => Response.json(await (await service(request,true)).get())),
    reservations: (request: Request) => handle(request,async () => Response.json(await (await service(request)).listReservations(options(request)))),
    corrections: (request: Request) => handle(request,async () => Response.json(await (await service(request)).listCorrections(options(request)))),
  };
}
