import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "jumpstart-compose-data-"));
const fixtures = [
  ["sqlite", ""],
  ["postgres", "DATABASE_URL=postgresql://fixture:fixture@database.example:5432/app\n"],
  ["supabase", "SUPABASE_URL=https://project.example\nSUPABASE_SECRET_KEY=fixture-secret\n"],
  ["convex", `CONVEX_SITE_URL=https://project.convex.site\nCONVEX_BACKEND_SECRET=${"x".repeat(32)}\n`],
];

function compose(args) {
  let executable = "docker", prefix = ["compose"];
  try { execFileSync(executable, [...prefix, "version"], { stdio: "ignore" }); }
  catch { executable = "docker-compose"; prefix = []; }
  return JSON.parse(execFileSync(executable, [...prefix, ...args, "config", "--format", "json"], {
    cwd: directory,
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, APP_DOMAIN: "app.example.com" },
  }));
}

try {
  mkdirSync(join(directory, "deploy"));
  for (const file of ["compose.yaml", "compose.streaming.yaml", "compose.public-https.yaml"])
    copyFileSync(resolve(file), join(directory, file));
  for (const file of ["split-app.Caddyfile", "split-app-routes.Caddyfile", "public-app.Caddyfile"])
    copyFileSync(resolve("deploy", file), join(directory, "deploy", file));

  for (const [provider, settings] of fixtures) {
    writeFileSync(join(directory, ".env.local"), `APP_ORIGIN=https://app.example.com\nDATA_PROVIDER=${provider}\n${settings}`, { mode: 0o600 });
    for (const files of [
      ["compose.yaml"],
      ["compose.yaml", "compose.streaming.yaml", "compose.public-https.yaml"],
    ]) {
      const config = compose(files.flatMap(file => ["-f", file]));
      const app = config.services.app;
      assert.equal(app.environment.DATA_PROVIDER, provider, `${files.join(" + ")} must honor ${provider}`);
      assert.equal(app.environment.SQLITE_PATH, "/app/.data/app.sqlite");
      assert.equal(app.environment.APP_ORIGIN, "https://app.example.com");
      assert.equal(config.services.postgres, undefined, "External providers must not start a bundled database");
      if (provider === "postgres") assert.equal(app.environment.DATABASE_URL, "postgresql://fixture:fixture@database.example:5432/app");
      if (provider === "supabase") {
        assert.equal(app.environment.SUPABASE_URL, "https://project.example");
        assert.equal(app.environment.SUPABASE_SECRET_KEY, "fixture-secret");
      }
      if (provider === "convex") {
        assert.equal(app.environment.CONVEX_SITE_URL, "https://project.convex.site");
        assert.equal(app.environment.CONVEX_BACKEND_SECRET, "x".repeat(32));
      }
      if (files.length > 1) assert.deepEqual(app.ports ?? [], [], "Public ingress must keep the app port private");
    }
  }
  console.log("Compose data providers passed: SQLite and external PostgreSQL, Supabase and Convex retain their selected runtime configuration.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
