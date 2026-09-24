import { z } from "zod";
import { accessOwner, type AccessOwner } from "../agent-access/contract";
import { micros, snapshot, ledgerQueryOptions, ledgerPage, type BudgetStore } from "./contract";

export const usageView = snapshot.extend({ dailyLimitMicros: micros.positive() }).strict();
export type UsageView = z.infer<typeof usageView>;

/** One owner-scoped usage view for browser, REST, CLI and MCP. */
export class UsageService {
  private owner: AccessOwner;
  private dailyLimitMicros: number;
  constructor(private store: BudgetStore | (() => Promise<BudgetStore>),owner: AccessOwner,dailyLimitMicros: number,private clock = Date.now) {
    this.owner = accessOwner.parse(owner);
    this.dailyLimitMicros = micros.positive().parse(dailyLimitMicros);
  }
  async get(): Promise<UsageView> {
    const store = typeof this.store === "function" ? await this.store() : this.store;
    return usageView.parse({ ...await store.snapshot({ ...this.owner,now: this.clock() }),dailyLimitMicros: this.dailyLimitMicros });
  }
  async listReservations(options: z.input<typeof ledgerQueryOptions> = {}) {
    const store = typeof this.store === "function" ? await this.store() : this.store;
    return ledgerPage.parse(await store.listLedger({ ...this.owner,...ledgerQueryOptions.parse(options) }));
  }
}
