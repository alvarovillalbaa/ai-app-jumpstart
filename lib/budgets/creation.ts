import { AppError } from "../http/errors";
import { accessOwner, type AccessOwner } from "../agent-access/contract";
import { ConversationBroker } from "../agent-access/broker";
import { creationBody, requestHash } from "../agent-access/signing";
import { budgetPolicy, micros, type BudgetStore } from "./contract";

/** A server-side admission boundary; callers supply a message, never prices/limits. */
export class BudgetedCreation {
  private policy: ReturnType<typeof budgetPolicy.parse>;
  constructor(private broker: ConversationBroker, private budgets: BudgetStore,
    policy: ReturnType<typeof budgetPolicy.parse>, private estimate: (message: string) => number,
    private clock = Date.now) { this.policy = budgetPolicy.parse(policy); }

  async create(rawOwner: AccessOwner, rawInput: unknown) {
    const owner = accessOwner.parse(rawOwner),{ requested,body } = creationBody(rawInput);
    const hash = requestHash(body);
    const result = await this.budgets.reserve({ ...owner, operationId: requested.operationId, requestHash: hash,
      estimateMicros: micros.positive().parse(this.estimate(requested.message)), policy: this.policy, now: this.clock() });
    if (result.status === "denied") {
      if (result.reason === "conflict") throw new AppError(409, "creation_conflict", "This operation already belongs to a different request.");
      throw new AppError(429, result.reason, "Your account cannot start another run within its current limits.");
    }
    // A settled operation is never a new authorization to dispatch. Likewise,
    // failures/timeouts below never refund capacity: acceptance may be ambiguous.
    if (result.status === "settled") return this.broker.read(owner,requested.operationId,hash);
    return this.broker.create(owner,requested);
  }
}
