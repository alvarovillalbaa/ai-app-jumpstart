import { AppError } from "../http/errors";
import { preferencePatch,type PreferenceStore } from "./contract";
import type { Owner } from "../data/contract";

export class PreferenceService {
  constructor(private store: () => Promise<PreferenceStore>,private owner: Owner) {}
  async get() { return (await this.store()).get(this.owner); }
  async update(input: unknown) {
    const saved = await (await this.store()).update(this.owner,preferencePatch.parse(input));
    if (!saved) throw new AppError(409,"preferences_changed","Your preferences changed. Refresh and try again.");
    return saved;
  }
}
