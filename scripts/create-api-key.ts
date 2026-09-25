import { randomBytes, createHash } from "node:crypto";
const [tenant, subject, access = "read"] = process.argv.slice(2);
const scopeSets: Record<string,string[]> = {
  read: ["records:read"],write: ["records:read","records:write"],
  "uploads-read": ["uploads:read"],"uploads-write": ["uploads:read","uploads:write"],
  "uploads-download": ["uploads:read","uploads:download"],
  "uploads-full": ["uploads:read","uploads:write","uploads:download"],
  "all-read": ["records:read","uploads:read"],
  "all-write": ["records:read","records:write","uploads:read","uploads:write"],
  "all-full": ["records:read","records:write","uploads:read","uploads:write","uploads:download"],
};
if (!tenant || !subject || !Object.hasOwn(scopeSets,access)) {
  console.error("Usage: npm run auth:key -- TENANT SUBJECT [read|write|uploads-read|uploads-write|uploads-download|uploads-full|all-read|all-write|all-full]");
  process.exitCode = 1;
} else {
  const token = randomBytes(32).toString("base64url");
  console.log(JSON.stringify({
    token,
    configuration: [{ sha256: createHash("sha256").update(token).digest("hex"), tenant, subject, scopes: scopeSets[access] }],
    instructions: "Keep the token private. Put the configuration array in server APP_API_KEYS. Tokens are shown only here; never commit this output.",
  }, null, 2));
}
