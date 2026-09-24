import { accessOwner, historyOptions, historyPatch, operationId, type AccessOwner, type SessionAccessStore } from "./contract";
import { AppError } from "../http/errors";
import { projectionOptions } from "./projection-contract";

/** Framework-neutral metadata service. Construct only after verifying account identity. */
export class ConversationHistoryService {
  private owner: AccessOwner;
  constructor(private store: SessionAccessStore, owner: AccessOwner) { this.owner = accessOwner.parse(owner); }
  list(input: unknown = {}) { return this.store.list(this.owner,historyOptions.parse(input)); }
  async events(input: unknown, options: unknown = {}) {
    const id = operationId.parse(input), q = projectionOptions.parse(options);
    await this.get(id);
    return this.store.listProjections(this.owner,id,q);
  }
  async get(input: unknown) {
    const row = await this.store.getDetails(this.owner,operationId.parse(input));
    if (!row) throw new AppError(404,"conversation_not_found","Conversation not found.");
    return row;
  }
  async update(input: unknown, value: unknown) {
    const id = operationId.parse(input), patch = historyPatch.parse(value);
    await this.get(id);
    const row = await this.store.updateDetails(this.owner,id,patch);
    if (!row) throw new AppError(409,"conversation_changed","This conversation changed. Refresh and try again.");
    return row;
  }
}
