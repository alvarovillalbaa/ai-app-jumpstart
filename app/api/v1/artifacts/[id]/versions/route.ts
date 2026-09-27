import { artifactHandlers } from "@/lib/http/artifacts";
export const runtime = "nodejs";
export async function GET(request: Request,context: { params: Promise<{ id: string }> }) {
  return artifactHandlers().versions(request,(await context.params).id);
}
