import { z } from "zod";
import { ConvexBackend } from "../data/convex-client";
import { conversation, historyOptions, historyPage, conversationSummary, type AccessOwner, type Reservation, type SessionAccessStore } from "./contract";
import { projectionEntry, projectionOptions, projectionOutcome, projectionPage, projectionSourceIndex } from "./projection-contract";
import { artifactInput, artifactCallId, artifactOptions, artifactSaveResult, artifactPage, artifact } from "./artifact-contract";

export function convexAccessStore(url: string, secret: string, request: typeof fetch = fetch): SessionAccessStore {
  const backend = new ConvexBackend(url, secret, request);
  return {
    saveArtifact: (owner,operationId,sessionId,callId,input) => backend.call("access.saveArtifact",{ ...owner,operationId,sessionId,callId: artifactCallId.parse(callId),input: artifactInput.parse(input) },artifactSaveResult),
    listArtifacts: (owner,options) => backend.call("access.listArtifacts",{ ...owner,options: artifactOptions.parse(options) },artifactPage),
    getArtifact: (owner,id) => backend.call("access.getArtifact",{ ...owner,id },artifact.nullable()),
    deleteArtifact: (owner,id) => backend.call("access.deleteArtifact",{ ...owner,id },z.boolean()),
    appendProjection: async (owner, operationId, sessionId, entry,sourceIndex) => backend.call("access.appendProjection",{ ...owner,operationId,sessionId,entry: projectionEntry.parse(entry),...(sourceIndex === undefined ? {} : { sourceIndex: projectionSourceIndex.parse(sourceIndex) }) },projectionOutcome),
    listProjections: async (owner, operationId, options) => backend.call("access.listProjections",{ ...owner,operationId,options: projectionOptions.parse(options) },projectionPage),
    reserve: (input: Reservation, title = "New conversation") => backend.call("access.reserve", { ...input,title }, z.boolean()),
    list: async (owner, options) => backend.call("access.list",{ ...owner,options: historyOptions.parse(options) },historyPage),
    getDetails: (owner, operationId) => backend.call("access.getDetails",{ ...owner,operationId },conversationSummary.nullable()),
    updateDetails: (owner, operationId, patch) => backend.call("access.updateDetails",{ ...owner,operationId,patch },conversationSummary.nullable()),
    getOperation: (owner: AccessOwner, operationId: string) => backend.call("access.getOperation", { ...owner, operationId }, conversation.nullable()),
    bind: (owner: AccessOwner, operationId: string, sessionId: string) => backend.call("access.bind", { ...owner, operationId, sessionId }, z.boolean()),
    cancelStarting: (owner: AccessOwner, operationId: string) => backend.call("access.cancelStarting", { ...owner, operationId }, z.boolean()),
    ownsSession: (owner: AccessOwner, sessionId: string) => backend.call("access.ownsSession", { ...owner, sessionId }, z.boolean()),
    revoke: (owner: AccessOwner, id: string) => backend.call("access.revoke", { ...owner, id }, z.boolean()),
    claimNonce: (id: string, expiresAt: number, now: number) => backend.call("access.claimNonce", { id, expiresAt, now }, z.boolean()),
    async close() {},
  };
}
