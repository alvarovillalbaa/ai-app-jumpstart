import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const documentPath = new URL("../../public/openapi.json", import.meta.url);
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

async function boundedBytes(response, maximum) {
  const reader = response.body?.getReader();
  assert.ok(reader, "Deployed API response has no body");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      assert.ok(size <= maximum, "Deployed API response exceeds the contract-check limit");
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function routeFor(paths, pathname) {
  const actual = pathname.split("/");
  return Object.entries(paths)
    .filter(([path]) => {
      const parts = path.split("/");
      return parts.length === actual.length && parts.every((part, index) =>
        (part.startsWith("{") && part.endsWith("}")) || part === actual[index]);
    })
    .sort(([left], [right]) => right.split("/").filter(part => !part.startsWith("{")).length -
      left.split("/").filter(part => !part.startsWith("{")).length)[0]?.[1];
}

/** Verify the deployed revision before writes, then validate successful REST JSON against its exact checked-out contract. */
export async function checkDeployedOpenApi(request) {
  const expected = await readFile(documentPath);
  assert.ok(expected.length <= MAX_DOCUMENT_BYTES, "Local OpenAPI document exceeds the contract-check limit");
  const response = await request("/openapi.json");
  assert.equal(response.status, 200, "Deployed OpenAPI document is unavailable");
  assert.match(response.headers.get("content-type") ?? "", /^application\/json(?:\s*;|$)/i,
    "Deployed OpenAPI document has the wrong media type");
  const received = await boundedBytes(response, MAX_DOCUMENT_BYTES);
  assert.ok(received.equals(expected), "Deployed OpenAPI document differs from this checkout; verify the release revision");

  const spec = JSON.parse(expected.toString("utf8"));
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  const validators = new Map();
  return async (path, method, result) => {
    if (!path.startsWith("/api/v1/") || result.status < 200 || result.status >= 300) return;
    const pathname = new URL(path, "https://local.invalid").pathname;
    const operation = routeFor(spec.paths, pathname)?.[method.toLowerCase()];
    assert.ok(operation, `Deployed REST operation is absent from OpenAPI: ${method} ${pathname}`);
    const documented = operation.responses[String(result.status)];
    assert.ok(documented, `Deployed REST success status is absent from OpenAPI: ${operation.operationId} ${result.status}`);
    const content = documented.content;
    if (!content) return;
    const [[mediaType, entry]] = Object.entries(content);
    assert.equal((result.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase(), mediaType,
      `Deployed REST media type differs from OpenAPI: ${operation.operationId}`);
    if (mediaType !== "application/json") return;
    const body = await boundedBytes(result.clone(), MAX_RESPONSE_BYTES);
    let value;
    try { value = JSON.parse(body.toString("utf8")); }
    catch { throw new Error(`Deployed REST response is not JSON: ${operation.operationId}`); }
    const key = `${operation.operationId}:${result.status}`;
    let validate = validators.get(key);
    if (!validate) {
      validate = ajv.compile({ components: spec.components, ...entry.schema });
      validators.set(key, validate);
    }
    assert.ok(validate(value), `Deployed REST response violates OpenAPI: ${operation.operationId} ${result.status}`);
  };
}
