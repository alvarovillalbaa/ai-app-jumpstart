import assert from "node:assert/strict";
import { cp,mkdir,mkdtemp,rm,symlink,writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { testCommand } from "./helpers/test-command.mjs";
import { startReferenceMcp } from "../lib/reference-mcp/server";

const root = fileURLToPath(new URL("../",import.meta.url)),directory = await mkdtemp(join(tmpdir(),"jumpstart-reference-mcp-"));
let forbidden = 0;
const service = await startReferenceMcp({ schemaVersion: 1,label: "Operator reference",items: [{ id: "example",title: "Example",content: "Operator-provided reference content" }] },{ blockedProbe: () => { forbidden++; } });
try {
  await cp(join(root,"tests/fixtures/eve-mcp"),directory,{ recursive: true });
  await symlink(join(root,"node_modules"),join(directory,"node_modules"),"dir");
  // Keep the authored production connection as the fixture's sole connection.
  await mkdir(join(directory,"agent/connections"));
  await writeFile(join(directory,"agent/connections/reference.ts"),`export { default } from ${JSON.stringify(join(root,"agent/connections/reference.ts"))};\n`);
  const env = { ...process.env,NODE_ENV: "development",EVE_TELEMETRY_DISABLED: "1",NITRO_PRESET: "node-server",REFERENCE_MCP_URL: service.url };
  for (const key of ["VERCEL","VERCEL_ENV","VERCEL_TARGET_ENV","VERCEL_OIDC_TOKEN","OPENAI_API_KEY","ANTHROPIC_API_KEY","AI_GATEWAY_API_KEY"]) delete (env as NodeJS.ProcessEnv)[key];
  await testCommand(join(root,"node_modules/.bin/eve"),["eval","enabled","--strict"],{ cwd: directory,env });
  assert.equal(service.calls.get,2);assert.equal(forbidden,0);
  await service.close();
  await testCommand(join(root,"node_modules/.bin/eve"),["eval","unavailable","--strict"],{ cwd: directory,env });
  assert.equal(service.calls.get,2);assert.equal(forbidden,0);
  delete (env as NodeJS.ProcessEnv).REFERENCE_MCP_URL;
  await testCommand(join(root,"node_modules/.bin/eve"),["eval","disabled","--strict"],{ cwd: directory,env });
  assert.equal(service.calls.get,2);assert.equal(forbidden,0);
  console.log("Native Eve MCP reference: real reads, filtered write metadata, missing-record/outage errors and unconfigured capability denial passed.");
} finally { await service.close();await rm(directory,{ recursive: true,force: true }); }
