# Read-only outbound MCP reference

The application data MCP endpoint at `/api/mcp` and Eve's outbound MCP client serve different purposes. `agent/connections/reference.ts` demonstrates the latter through Eve's native `defineDynamic` and `defineMcpClientConnection` APIs. Its fixed allowlist exposes only `catalog_list` and `catalog_get`; it does not install another runtime MCP client.

This is an opt-in local development reference. It reads operator-provided shared catalog data, not an individual's third-party account. With no `REFERENCE_MCP_URL`, the connection and its discovery tools are absent. Configured references require `NODE_ENV=development` and a canonical `http://127.0.0.1:PORT/mcp` URL, with ports 1024–65535. Remote hosts, alternate numeric IP spellings, credentials, queries, fragments and alternate paths are rejected. A configured production runtime fails resolution before making a connection. Production third-party integrations still require a reviewed endpoint, egress/redirect controls and app- or user-scoped credentials.

## Run the reference

Create a JSON file containing your intended reference data:

```json
{
  "schemaVersion": 1,
  "label": "Development reference",
  "items": [
    {"id": "example", "title": "Example", "content": "Your reference content"}
  ]
}
```

Start the actual read-only MCP server:

```sh
npm run mcp:reference -- --data /absolute/path/reference.json --port 3191
```

Set `REFERENCE_MCP_URL=http://127.0.0.1:3191/mcp` in the agent's development environment and run `npm run dev`. Ask the agent to read the reference item `example`. A development turn still uses the configured production model and may incur provider usage. `npm run test:reference-mcp` uses a separate deterministic model fixture with no provider credentials or charges.

The server binds IPv4 loopback, validates Host and any supplied Origin, has no credential/URL arguments in its tools and serves no redirects. No browser credential is needed for this intentionally local shared dataset. Keep sensitive account data out of it. The CLI requires an explicit data file of at most 32 KiB; it never invents a catalog or supplies successful demo data to a production deployment. The catalog is validated and snapshotted at startup. Restart it to load a changed file.

Catalogs hold at most 100 unique IDs. IDs are restricted to lowercase letters, digits, underscores and hyphens; titles fit within 120 characters and content within 2,000. `catalog_list` returns at most ten IDs/titles with a bounded numeric next offset; `catalog_get` returns one item. A missing item returns MCP `isError:true` with `not_found`. Eve preserves that protocol flag in the result payload; it is distinct from its own executor failure flag. Treat either as an error and do not invent data.

The HTTP handler accepts at most 16 KiB, admits four active POST requests and aborts an active request after five seconds. Invalid paths/methods, hostile hosts/origins and excessive bodies are denied. The packaged service has no mutation, storage, shell, arbitrary fetch or redirect operation. Tool annotations describe intent; the native fixed allowlist and actual server behavior enforce this example's read-only surface.

## Reuse and verify

Run `npm run test:reference-mcp`. Its temporary app imports the authored production connection, starts the real MCP service and exercises Eve's HTTP/session runtime with a deterministic model. Five eval cases cover discovery filtering, an actual remote read, a missing item, a stopped service and an unconfigured connection. The server deliberately advertises a forbidden delete probe only in this harness; assertions verify it never becomes model-callable and is never invoked. Disabling the connection sends no additional catalog reads. The temporary server and runtime files are cleaned up.

Root SDK tests cover paging/output bounds, missing and unknown tools, invalid limits, unique identities, hostile hosts/origins and oversized bodies. Configuration tests cover production denial and noncanonical/private-network endpoints. CI runs the native eval command in its contracts job.

For a real product integration, search Eve's registry first and read the installed connection documentation. Do not expand this loopback example into an arbitrary-URL proxy or present one global token as a user's account. User connections need verified caller ownership, a stable non-secret instance identity, encrypted credential references, expiration/reconnect/disconnect behavior and appropriate approval policies. Managed/serverless acceptance and paid production-model behavior remain separate evidence.
