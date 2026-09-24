import { artifactHandlers } from "@/lib/http/artifacts";
export const runtime = "nodejs";
export async function GET(request: Request,context: { params: Promise<{ id: string }> }) {
  return artifactHandlers().get(request,(await context.params).id);
}
export async function DELETE(request: Request,context: { params: Promise<{ id: string }> }) {
  return artifactHandlers().delete(request,(await context.params).id);
}
