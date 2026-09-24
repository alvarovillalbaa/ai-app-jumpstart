import { z } from "zod";
import { ConversationHistoryService } from "../agent-access/history";
import { chatIdentity } from "../agent-access/identity";
import { requireChatSettings } from "../agent-access/settings";
import { getSessionAccessStore } from "../agent-access/store";
import type { SessionAccessStore } from "../agent-access/contract";
import { handle, readJson } from "./handler";

export function conversationHandlers(store: () => Promise<SessionAccessStore> = getSessionAccessStore) {
  async function service(request: Request) {
    const settings = requireChatSettings(), owner = await chatIdentity(request,settings.auth);
    return new ConversationHistoryService(await store(),owner);
  }
  return {
    events: (request: Request,id: string) => handle(request,async () => {
      const s = await service(request);
      const options = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20),after: z.coerce.number().int().nonnegative().optional() }).strict().parse(Object.fromEntries(new URL(request.url).searchParams));
      return Response.json(await s.events(id,options));
    }),
    list: (request: Request) => handle(request,async () => {
      const s = await service(request);
      const options = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), archived: z.enum(["true","false"]).default("false").transform(value => value === "true"), cursor: z.string().optional() }).strict().parse(Object.fromEntries(new URL(request.url).searchParams));
      return Response.json(await s.list(options));
    }),
    get: (request: Request, id: string) => handle(request,async () => Response.json(await (await service(request)).get(id))),
    update: (request: Request, id: string) => handle(request,async () => {
      const s = await service(request);
      return Response.json(await s.update(id,await readJson(request)));
    }),
  };
}
