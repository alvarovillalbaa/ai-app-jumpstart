import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { run } from "../../scripts/app-cli";
import type { CliAuthDependencies } from "../../scripts/cli-auth";

const config = { APP_API_URL: "https://app.example", SUPABASE_AUTH_URL: "https://identity.example", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test-key-with-enough-entropy" };

afterEach(() => vi.unstubAllEnvs());

it("signs in interactively, refreshes the saved session, and revokes only that local Supabase session on logout", async () => {
  let now = 1_800_000_000_000;
  const sessions: Array<{ access_token: string; refresh_token: string; expires_in: number; expires_at: number }> = [];
  const methods = {
    signInWithPassword: vi.fn(async ({ email, password }: { email: string; password: string }) => {
      expect(email).toBe("person@example.test");
      expect(password).toBe("private-password");
      const session = { access_token: "short-lived-access-secret", refresh_token: "long-lived-refresh-secret", expires_in: 30, expires_at: Math.floor(now / 1000) + 30 };
      sessions.push(session);
      return { data: { session }, error: null };
    }),
    refreshSession: vi.fn(async ({ refresh_token }: { refresh_token: string }) => {
      expect(refresh_token).toBe("long-lived-refresh-secret");
      const session = { access_token: "refreshed-access-secret", refresh_token: "rotated-refresh-secret", expires_in: 3600, expires_at: Math.floor(now / 1000) + 3600 };
      sessions.push(session);
      return { data: { session }, error: null };
    }),
    setSession: vi.fn(async ({ access_token, refresh_token }: { access_token: string; refresh_token: string }) => {
      expect(access_token).toBe("refreshed-access-secret");
      expect(refresh_token).toBe("rotated-refresh-secret");
      return { data: { session: sessions.at(-1)! }, error: null };
    }),
    signOut: vi.fn(async ({ scope }: { scope?: "local" | "global" | "others" } = {}) => {
      expect(scope).toBe("local");
      return { error: null };
    }),
  };
  const dependencies: CliAuthDependencies = {
    configRoot: await mkdtemp(join(tmpdir(), "jumpstart-cli-auth-")),
    now: () => now,
    createClient: () => ({ auth: methods }) as never,
    promptCredentials: async () => ({ email: "person@example.test", password: "private-password" }),
  };
  try {
    expect(await run(["auth", "login"], config, fetch, dependencies)).toMatchObject({ status: "authenticated", source: "saved-session" });
    expect(methods.signInWithPassword).toHaveBeenCalledOnce();
    await expect(run(["auth", "login"], config, fetch, dependencies)).rejects.toThrow("Run auth logout before switching accounts");
    expect(methods.signInWithPassword).toHaveBeenCalledOnce();
    const directory = join(dependencies.configRoot!, "ai-app-jumpstart", "auth");
    const [name] = await readdir(directory);
    const file = join(directory, name);
    const saved = await readFile(file, "utf8");
    expect(saved).not.toContain("person@example.test");
    expect(saved).not.toContain("private-password");
    expect(saved).toContain("long-lived-refresh-secret");
    if (process.platform !== "win32") {
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
      expect((await lstat(file)).mode & 0o777).toBe(0o600);
    }

    const request = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer refreshed-access-secret");
      return Response.json({ items: [], nextCursor: null });
    });
    expect(await run(["list"], config, request, dependencies)).toMatchObject({ items: [], nextCursor: null });
    expect(methods.refreshSession).toHaveBeenCalledOnce();
    const status = await run(["auth", "status"], config, fetch, dependencies);
    expect(status).toMatchObject({ status: "authenticated", source: "saved-session" });

    now += 3_600_000;
    expect(await run(["auth", "logout"], config, fetch, dependencies)).toMatchObject({ status: "signed-out", savedSessionRemoved: true, remoteRevoked: true });
    expect(methods.setSession).toHaveBeenCalledOnce();
    expect(methods.signOut).toHaveBeenCalledOnce();
    expect(await run(["auth", "status"], config, fetch, dependencies)).toMatchObject({ status: "signed-out" });
    expect(await readdir(directory)).toEqual([]);
  } finally { await rm(dependencies.configRoot!, { recursive: true, force: true }); }
});

it("uses an environment API token before loading or refreshing a saved session", async () => {
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer automation-token");
    return Response.json({ items: [], nextCursor: null });
  });
  const createClient = vi.fn();
  await run(["list"], { APP_API_URL: "https://app.example", APP_API_TOKEN: "automation-token" }, request, { createClient });
  expect(request).toHaveBeenCalledOnce();
  expect(createClient).not.toHaveBeenCalled();
});

it("does not claim logout while an environment API token remains active", async () => {
  const createClient = vi.fn();
  await expect(run(["auth", "logout"], {
    APP_API_URL: "https://app.example", APP_API_TOKEN: "automation-token",
  }, fetch, { createClient })).rejects.toThrow("cannot be revoked by auth logout");
  expect(createClient).not.toHaveBeenCalled();
});

it("does not persist a failed sign-in response or expose provider diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "jumpstart-cli-auth-failure-"));
  const dependencies: CliAuthDependencies = {
    configRoot: root,
    createClient: () => ({ auth: { signInWithPassword: async () => ({ data: { session: null }, error: new Error("private-provider-detail") }) } }) as never,
    promptCredentials: async () => ({ email: "person@example.test", password: "private-password" }),
  };
  try {
    const directory = join(root, "ai-app-jumpstart", "auth");
    let failure: unknown;
    try { await run(["auth", "login"], config, fetch, dependencies); } catch (error) { failure = error; }
    expect(String(failure)).toContain("Supabase sign-in failed");
    expect(String(failure)).not.toContain("private-provider-detail");
    expect(await readdir(directory)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("keeps deployment sessions isolated and rejects a symlinked credential file", async () => {
  const root = await mkdtemp(join(tmpdir(), "jumpstart-cli-auth-symlink-"));
  const authOrigin = "https://identity.example";
  const apiOrigin = "https://app.example";
  const profile = createHash("sha256").update(`${apiOrigin}\n${authOrigin}`).digest("hex");
  const directory = join(root, "ai-app-jumpstart", "auth");
  const file = join(directory, `${profile}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(root, "outside.json"), "{}");
  await symlink(join(root, "outside.json"), file);
  try {
    await expect(run(["auth", "status"], config, fetch, { configRoot: root })).rejects.toThrow("invalid");
    expect(await readFile(join(root, "outside.json"), "utf8")).toBe("{}");
  } finally { await rm(root, { recursive: true, force: true }); }
});
