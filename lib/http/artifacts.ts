import { z } from "zod";
import { ArtifactService } from "../agent-access/artifacts";
import { chatIdentity } from "../agent-access/identity";
import { requireChatSettings } from "../agent-access/settings";
import { getSessionAccessStore } from "../agent-access/store";
import type { SessionAccessStore } from "../agent-access/contract";
import { handle } from "./handler";

export function artifactHandlers(store: () => Promise<SessionAccessStore> = getSessionAccessStore) {
  async function service(request: Request) {
    const settings = requireChatSettings(),owner = await chatIdentity(request,settings.auth);
    return new ArtifactService(await store(),owner);
  }
  return {
    list: (request: Request) => handle(request,async () => {
      const options = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20),cursor: z.string().optional() }).strict().parse(Object.fromEntries(new URL(request.url).searchParams));
      return Response.json(await (await service(request)).list(options));
    }),
    get: (request: Request,id: string) => handle(request,async () => Response.json(await (await service(request)).get(id))),
    download: (request: Request,id: string) => handle(request,async () => {
      const item = await (await service(request)).get(id);
      return new Response(item.content,{ headers: { "content-type": "text/plain; charset=utf-8","content-disposition": `attachment; filename="artifact-${item.id}.txt"` } });
    }),
    delete: (request: Request,id: string) => handle(request,async () => {
      await (await service(request)).delete(id);
      return new Response(null,{ status: 204 });
    }),
  };
}
