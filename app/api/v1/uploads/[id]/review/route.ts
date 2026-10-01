import { uploadHandlers } from "@/lib/http/uploads";
export const runtime = "nodejs";
export async function GET(request: Request,context: { params: Promise<{ id: string }> }) {
  return uploadHandlers().review(request,(await context.params).id);
}
export async function PUT(request: Request,context: { params: Promise<{ id: string }> }) {
  return uploadHandlers().decideReview(request,(await context.params).id);
}
