import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { artifactInput } from "../../lib/agent-access/artifact-contract";
import { accessOwner, operationId } from "../../lib/agent-access/contract";
import { getSessionAccessStore } from "../../lib/agent-access/store";

const outputSchema = z.object({ id: z.uuid(),title: z.string(),createdAt: z.number().int(),mediaType: z.literal("text/plain") }).strict();
export default defineTool({
  description: "Propose a private plain-text artifact with the exact title and content to show the user for approval. Save it only after approval. Use for a user-requested durable note or draft; do not claim it was saved before the tool succeeds.",
  inputSchema: artifactInput,
  outputSchema,
  label: { start: ({ title }) => `Create private artifact: ${title}` },
  approval: {
    request: context => {
      const { session } = context;
      const first = session.auth.initiator,current = session.auth.current;
      if (first?.authenticator !== "jumpstart" || current?.authenticator !== "jumpstart" ||
          first.issuer !== current.issuer || first.principalId !== current.principalId) return { type: "denied",reason: "Only the conversation owner may create an artifact." };
      return always()(context);
    },
    response: ({ responder,session }) => responder.authenticator === "jumpstart" &&
      responder.principalId === session.initiator?.principalId && responder.issuer === session.initiator?.issuer
      ? { status: "allowed" } : { status: "rejected",reason: "Only the conversation owner may approve this artifact." },
  },
  async execute(input,ctx) {
    const first = ctx.session.auth.initiator,current = ctx.session.auth.current;
    if (first?.authenticator !== "jumpstart" || current?.authenticator !== "jumpstart" ||
        first.issuer !== current.issuer || first.principalId !== current.principalId) throw new Error("Artifact owner verification failed.");
    const owner = accessOwner.parse({ tenant: first.issuer,subject: first.principalId });
    const result = await (await getSessionAccessStore()).saveArtifact(owner,operationId.parse(first.attributes.creationOperationId),ctx.session.id,ctx.callId,input);
    if (result.status === "conflict") throw new Error("Artifact call input changed; request a new approval.");
    if (result.status === "unavailable") throw new Error("Conversation is no longer active for artifact creation.");
    return outputSchema.parse({ id: result.artifact.id,title: result.artifact.title,createdAt: result.artifact.createdAt,mediaType: result.artifact.mediaType });
  },
});
