import { uploadHandlers } from "@/lib/http/uploads";
export const runtime = "nodejs";
export async function GET(request: Request,context: { params: Promise<{ id: string }> }) {
  return uploadHandlers().get(request,(await context.params).id);
}
export async function DELETE(request: Request,context: { params: Promise<{ id: string }> }) {
  return uploadHandlers().delete(request,(await context.params).id);
}
