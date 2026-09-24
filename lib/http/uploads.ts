import { authenticate } from "./auth";
import { AppError } from "./errors";
import { handle } from "./handler";
import { getUploadCatalog } from "../uploads/catalog-store";
import { createUploadObjects } from "../uploads/objects-store";
import { UploadService } from "../uploads/service";
import type { UploadCatalog } from "../uploads/catalog-contract";
import type { PrivateUploadObjects } from "../uploads/contract";
import { MAX_API_UPLOAD_BYTES } from "../uploads/validation";
import { createUploadScanner } from "../uploads/scanner";
import type { UploadScanner } from "../uploads/scanner";
export { MAX_API_UPLOAD_BYTES } from "../uploads/validation";

async function uploadBody(request: Request) {
  if (request.headers.get("content-type")?.toLowerCase().trim() !== "application/octet-stream" ||
      ![null,"identity"].includes(request.headers.get("content-encoding"))) {
    throw new AppError(415,"unsupported_media_type","Send uncompressed application/octet-stream bytes.");
  }
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_API_UPLOAD_BYTES)) {
    throw new AppError(413,"body_too_large","Upload exceeds the 4 MiB API limit.");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new AppError(400,"invalid_upload","Upload bytes are required.");
  const chunks: Uint8Array[] = [];let size = 0;
  try {
    while (true) {
      const { value,done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_API_UPLOAD_BYTES) { await reader.cancel();throw new AppError(413,"body_too_large","Upload exceeds the 4 MiB API limit."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!size) throw new AppError(400,"invalid_upload","Upload bytes are required.");
  return new Uint8Array(Buffer.concat(chunks,size));
}

function uploadHeaders(request: Request) {
  const encoded = request.headers.get("x-upload-name"),mediaType = request.headers.get("x-upload-media-type");
  if (!encoded || encoded.length > 512 || !mediaType) throw new AppError(400,"invalid_upload","Upload name and media type are required.");
  try { return { name: decodeURIComponent(encoded),mediaType }; }
  catch { throw new AppError(400,"invalid_upload","Upload name encoding is invalid."); }
}

export function uploadHandlers(catalog: () => Promise<UploadCatalog> = getUploadCatalog,
  objects: () => Promise<PrivateUploadObjects> = createUploadObjects,
  scanner: () => Promise<UploadScanner | null> = createUploadScanner) {
  async function service(request: Request) {
    const principal = await authenticate(request);
    return new UploadService(await catalog(),objects,principal,scanner);
  }
  return {
    list: (request: Request) => handle(request,async () => {
      const s = await service(request);
      return Response.json({ items: await s.list(),usage: await s.usage() });
    }),
    create: (request: Request) => handle(request,async () => {
      const s = await service(request),headers = uploadHeaders(request);
      const row = await s.accept(headers.name,headers.mediaType,await uploadBody(request));
      return Response.json(row,{ status: 201,headers: { location: `/api/v1/uploads/${row.id}` } });
    }),
    get: (request: Request,id: string) => handle(request,async () => Response.json(await (await service(request)).get(id))),
    delete: (request: Request,id: string) => handle(request,async () => {
      await (await service(request)).delete(id);
      return new Response(null,{ status: 204 });
    }),
  };
}
