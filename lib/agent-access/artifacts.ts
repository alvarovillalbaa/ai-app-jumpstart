import { AppError } from "../http/errors";
import { accessOwner, type AccessOwner, type SessionAccessStore } from "./contract";
import { artifactOptions } from "./artifact-contract";
import { z } from "zod";

/** Creation is exclusively through Eve's approved tool; owners can erase saved text. */
export class ArtifactService {
  constructor(private store: SessionAccessStore,private owner: AccessOwner) { this.owner = accessOwner.parse(owner); }
  list(options: unknown = {}) { return this.store.listArtifacts(this.owner,artifactOptions.parse(options)); }
  async get(id: unknown) {
    const value = await this.store.getArtifact(this.owner,z.uuid().parse(id));
    if (!value) throw new AppError(404,"artifact_not_found","Artifact not found.");
    return value;
  }
  async delete(id: unknown) {
    if (!await this.store.deleteArtifact(this.owner,z.uuid().parse(id))) throw new AppError(404,"artifact_not_found","Artifact not found.");
  }
}
