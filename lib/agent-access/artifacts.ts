import { AppError } from "../http/errors";
import { accessOwner, type AccessOwner, type SessionAccessStore } from "./contract";
import { artifactOptions,artifactPatch,artifactVersionOptions } from "./artifact-contract";
import { z } from "zod";

/** Approved creation is immutable; owners can append bounded versions or erase all saved text. */
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
  async versions(id: unknown,options: unknown = {}) {
    const result = await this.store.listArtifactVersions(this.owner,z.uuid().parse(id),artifactVersionOptions.parse(options));
    if (!result) throw new AppError(404,"artifact_not_found","Artifact not found.");
    return result;
  }
  async update(id: unknown,input: unknown) {
    const result = await this.store.updateArtifact(this.owner,z.uuid().parse(id),artifactPatch.parse(input));
    if (result.status === "unavailable") throw new AppError(404,"artifact_not_found","Artifact not found.");
    if (result.status === "conflict") throw new AppError(409,"artifact_conflict","The artifact changed. Refresh before saving your edit.");
    if (result.status === "limit") throw new AppError(409,"artifact_version_limit","This artifact has reached its 100-version limit.");
    return result.artifact;
  }
}
