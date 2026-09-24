const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Browser-facing or credential-bearing service origins; never accept remote plaintext HTTP. */
export function trustedHttpOrigin(value: unknown): string | null {
  if (typeof value !== "string" || !value || value !== value.trim() || value.includes("?") || value.includes("#")) return null;
  try {
    const url = new URL(value);
    if (url.origin.length > 180 || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback.has(url.hostname))) return null;
    return url.origin;
  } catch { return null; }
}
