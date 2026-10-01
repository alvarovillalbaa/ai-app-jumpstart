import { z } from "zod";
import { accessOwner, type AccessOwner } from "../agent-access/contract";
import { micros, snapshot, ledgerQueryOptions, ledgerPage, ownerCorrectionPage, type BudgetStore } from "./contract";

// Null means account chat is disabled, never zero cost or unlimited allowance.
export const usageView = snapshot.extend({ dailyLimitMicros: micros.positive().nullable() }).strict();
export type UsageView = z.infer<typeof usageView>;

/** One owner-scoped usage view for browser, REST, CLI and MCP. */
export class UsageService {
  private owner: AccessOwner;
  private dailyLimitMicros: number | null;
  constructor(private store: BudgetStore | (() => Promise<BudgetStore>),owner: AccessOwner,dailyLimitMicros: number | null,private clock = Date.now) {
    this.owner = accessOwner.parse(owner);
    this.dailyLimitMicros = usageView.shape.dailyLimitMicros.parse(dailyLimitMicros);
  }
  async get(): Promise<UsageView> {
    const store = typeof this.store === "function" ? await this.store() : this.store;
    return usageView.parse({ ...await store.snapshot({ ...this.owner,now: this.clock() }),dailyLimitMicros: this.dailyLimitMicros });
  }
  async listReservations(options: z.input<typeof ledgerQueryOptions> = {}) {
    const store = typeof this.store === "function" ? await this.store() : this.store;
    return ledgerPage.parse(await store.listLedger({ ...this.owner,...ledgerQueryOptions.parse(options) }));
  }
  async listCorrections(options: z.input<typeof ledgerQueryOptions> = {}) {
    const store = typeof this.store === "function" ? await this.store() : this.store;
    return ownerCorrectionPage.parse(await store.listOwnerCorrections({ ...this.owner,...ledgerQueryOptions.parse(options) }));
  }
}
