import { randomBytes, createHash } from "node:crypto";
const [tenant, subject, access = "read"] = process.argv.slice(2);
if (!tenant || !subject || !["read", "write"].includes(access)) {
  console.error("Usage: npm run auth:key -- TENANT SUBJECT [read|write]");
  process.exitCode = 1;
} else {
  const token = randomBytes(32).toString("base64url");
  console.log(JSON.stringify({
    token,
    configuration: [{ sha256: createHash("sha256").update(token).digest("hex"), tenant, subject, scopes: access === "write" ? ["records:read", "records:write"] : ["records:read"] }],
    instructions: "Keep the token private. Put the configuration array in server APP_API_KEYS. Tokens are shown only here; never commit this output.",
  }, null, 2));
}
