/** This reference uses an operator-owned loopback service in development. */
export function referenceMcpUrl(env: NodeJS.ProcessEnv = process.env): string|null {
  const value = env.REFERENCE_MCP_URL;
  if (!value) return null;
  if (env.NODE_ENV !== "development") throw new Error("Reference MCP requires development mode; production integrations need a reviewed endpoint and credential policy.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Use a loopback reference MCP URL."); }
  if (!/^http:\/\/127\.0\.0\.1:\d{4,5}\/mcp$/.test(value) || value !== url.href || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password ||
    url.pathname !== "/mcp" || url.search || url.hash || !url.port || Number(url.port) < 1024 || Number(url.port) > 65535)
    throw new Error("Reference MCP must use http://127.0.0.1:PORT/mcp with a port between 1024 and 65535.");
  return url.href;
}
