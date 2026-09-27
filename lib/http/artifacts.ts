import { z } from "zod";
import { ArtifactService } from "../agent-access/artifacts";
import { authenticateAccountData } from "./authenticated-data";
import { requireAuthSettings } from "../auth/settings";
import { getSessionAccessStore } from "../agent-access/store";
import type { SessionAccessStore } from "../agent-access/contract";
import { handle, readJson } from "./handler";

export function artifactHandlers(store: () => Promise<SessionAccessStore> = getSessionAccessStore) {
  async function service(request: Request) {
    const owner = await authenticateAccountData(request,requireAuthSettings());
    return new ArtifactService(await store(),owner);
  }
  return {
    list: (request: Request) => handle(request,async () => {
      const options = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20),cursor: z.string().optional() }).strict().parse(Object.fromEntries(new URL(request.url).searchParams));
      return Response.json(await (await service(request)).list(options));
    }),
    get: (request: Request,id: string) => handle(request,async () => Response.json(await (await service(request)).get(id))),
    update: (request: Request,id: string) => handle(request,async () => {
      const s = await service(request);
      return Response.json(await s.update(id,await readJson(request)));
    }),
    versions: (request: Request,id: string) => handle(request,async () => {
      const s = await service(request);
      const options = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20),before: z.coerce.number().int().min(1).max(101).optional() }).strict().parse(Object.fromEntries(new URL(request.url).searchParams));
      return Response.json(await s.versions(id,options));
    }),
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
