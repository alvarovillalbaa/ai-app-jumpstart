import type { SessionAccessStore } from "../agent-access/contract";
import { outstandingOptions, type BudgetStore, type OutstandingOptions } from "./contract";

/** Read-only, nontransactional inventory for an operator with backend credentials. */
export async function inspectOutstandingStarts(access: SessionAccessStore, budgets: BudgetStore, raw: OutstandingOptions) {
  const page = await budgets.listOutstanding(outstandingOptions.parse(raw));
  const items = [];
  // Bound concurrent provider calls. Each row can change after this read.
  for (let offset = 0; offset < page.items.length; offset += 8) {
    const batch = await Promise.all(page.items.slice(offset,offset+8).map(async item => {
      const owner = { tenant: item.tenant,subject: item.subject };
      const [conversation,attempts] = await Promise.all([
        access.getOperation(owner,item.operationId),
        budgets.attemptCount({ ...owner,operationId: item.operationId }),
      ]);
      return { ...item,conversationId: conversation?.id ?? null,conversationStatus: conversation?.status ?? "missing",
        sessionId: conversation?.sessionId ?? null,attempts };
    }));
    items.push(...batch);
  }
  return { items,nextCursor: page.nextCursor,inspectedAt: Date.now() };
}
