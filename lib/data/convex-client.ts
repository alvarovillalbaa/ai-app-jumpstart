import { z } from "zod";
import { AppError } from "../http/errors";

/** Authenticated, validated server-to-server transport shared by data adapters. */
export class ConvexBackend {
  private endpoint: URL;
  constructor(siteUrl: string, private secret: string, private request: typeof fetch = fetch) {
    const url = new URL(siteUrl);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("CONVEX_SITE_URL must be an origin without credentials, path, query or fragment.");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Use HTTPS for a remote Convex backend.");
    if (secret.length < 32 || secret.length > 512) throw new Error("CONVEX_BACKEND_SECRET must contain 32–512 characters.");
    this.endpoint = new URL("/app/records", url);
  }
  async call<T>(operation: string, args: object, schema: z.ZodType<T>) {
    const response = await this.request(this.endpoint, {
      method: "POST", body: JSON.stringify({ ...args, operation }), redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json", "x-jumpstart-backend-key": this.secret },
    });
    if (!response.ok) throw new AppError(503, "storage_unavailable", "The data provider could not complete this request.");
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new AppError(503, "storage_contract_error", "The data provider returned an invalid response.");
    return parsed.data;
  }
}
