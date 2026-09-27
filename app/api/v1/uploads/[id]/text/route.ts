import { uploadHandlers } from "@/lib/http/uploads";
export const runtime = "nodejs";
export async function GET(request: Request,context: { params: Promise<{ id: string }> }) {
  return uploadHandlers().extractText(request,(await context.params).id);
}
