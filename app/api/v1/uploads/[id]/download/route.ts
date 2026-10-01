import { uploadHandlers } from "@/lib/http/uploads";

export const runtime = "nodejs";
export async function GET(request: Request,context: { params: Promise<{ id: string }> }) {
  return uploadHandlers().download(request,(await context.params).id);
}
