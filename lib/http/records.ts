import { authenticate } from "./auth";
import { handle, readJson } from "./handler";
import { getRepository } from "../data/repository";
import { RecordService } from "../data/service";
import type { RecordRepository } from "../data/contract";

/** Dependency injection lets every adapter reuse the same HTTP contract tests. */
export function recordHandlers(repository: () => Promise<RecordRepository> = getRepository) {
  async function service(request: Request) {
    const principal = await authenticate(request);
    return new RecordService(await repository(), principal);
  }
  return {
    list: (request: Request) => handle(request, async () => {
      const s = await service(request);
      return Response.json(await s.list(Object.fromEntries(new URL(request.url).searchParams)));
    }),
    create: (request: Request) => handle(request, async () => {
      const s = await service(request);
      const input = await readJson(request),key = request.headers.get("idempotency-key");
      const result = key === null ? { status: "created",record: await s.create(input) } : await s.createOnce(key,input);
      return Response.json(result.record, { status: result.status === "created" ? 201 : 200,
        headers: { location: `/api/v1/records/${result.record.id}`,...(key === null ? {} : { "idempotency-replayed": String(result.status === "existing") }) } });
    }),
    creation: (request: Request,key: string) => handle(request,async () => Response.json(await (await service(request)).creation(key))),
    get: (request: Request, id: string) => handle(request, async () => Response.json(await (await service(request)).get(id))),
    update: (request: Request, id: string) => handle(request, async () => {
      const s = await service(request);
      return Response.json(await s.update(id, await readJson(request)));
    }),
    delete: (request: Request, id: string) => handle(request, async () => {
      await (await service(request)).delete(id, new URL(request.url).searchParams.get("revision"));
      return new Response(null, { status: 204 });
    }),
  };
}
