import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { StringDecoder } from "node:string_decoder";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { authSettings } from "../lib/auth/settings";

const savedSession = z.object({
  version: z.literal(1),
  apiOrigin: z.string().url(),
  authOrigin: z.string().url(),
  accessToken: z.string().min(1).max(32_768),
  refreshToken: z.string().min(1).max(32_768),
  expiresAt: z.number().int().positive(),
}).strict();

type SavedSession = z.infer<typeof savedSession>;
type AuthSession = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at?: number;
};
type AuthClient = {
  auth: {
    signInWithPassword(input: { email: string; password: string }): Promise<{ data: { session: AuthSession | null }; error: unknown }>;
    refreshSession(input: { refresh_token: string }): Promise<{ data: { session: AuthSession | null }; error: unknown }>;
    setSession(input: { access_token: string; refresh_token: string }): Promise<{ data: { session: AuthSession | null }; error: unknown }>;
    signOut(input?: { scope?: "local" | "global" | "others" }): Promise<{ error: unknown }>;
  };
};

export type CliAuthDependencies = {
  createClient?: (url: string, key: string) => AuthClient;
  promptCredentials?: () => Promise<{ email: string; password: string }>;
  configRoot?: string;
  now?: () => number;
};

const defaultClient = (url: string, key: string): AuthClient => {
  const memory = new Map<string, string>();
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: true,
      storage: {
        getItem: async name => memory.get(name) ?? null,
        setItem: async (name, value) => { memory.set(name, value); },
        removeItem: async name => { memory.delete(name); },
      },
    },
  }) as unknown as AuthClient;
};

function apiOriginFrom(env: Record<string, string | undefined>): string {
  let target: URL;
  try { target = new URL(env.APP_API_URL ?? "http://localhost:3000"); }
  catch { throw new Error("APP_API_URL must be an HTTP(S) origin without credentials, path, query or fragment."); }
  if (target.username || target.password || target.pathname !== "/" || target.search || target.hash || !["http:", "https:"].includes(target.protocol)) {
    throw new Error("APP_API_URL must be an HTTP(S) origin without credentials, path, query or fragment.");
  }
  if (target.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
    throw new Error("Use HTTPS for remote servers.");
  }
  return target.origin;
}

function authConfiguration(env: Record<string, string | undefined>) {
  let configuration;
  try { configuration = authSettings({ ...env, AUTH_PROVIDER: "supabase" } as unknown as NodeJS.ProcessEnv); }
  catch { throw new Error("Configure SUPABASE_AUTH_URL (or SUPABASE_URL) and a public SUPABASE_PUBLISHABLE_KEY."); }
  if (!configuration) throw new Error("Configure SUPABASE_AUTH_URL (or SUPABASE_URL) and a public SUPABASE_PUBLISHABLE_KEY.");
  return configuration;
}

function sessionDirectory(env: Record<string, string | undefined>, dependencyRoot?: string): string {
  const root = dependencyRoot ?? (process.platform === "win32"
    ? env.APPDATA ?? join(homedir(), "AppData", "Roaming")
    : env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  if (!isAbsolute(root)) throw new Error("The CLI config directory must be an absolute path.");
  return join(root, "ai-app-jumpstart", "auth");
}

function sessionFile(apiOrigin: string, authOrigin: string, directory: string): string {
  const profile = createHash("sha256").update(`${apiOrigin}\n${authOrigin}`).digest("hex");
  return join(directory, `${profile}.json`);
}

async function secureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("The CLI session directory is not a private directory.");
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("The CLI session directory must belong to the current user.");
    await chmod(directory, 0o700);
    const secured = await lstat(directory);
    if ((secured.mode & 0o077) !== 0) throw new Error("The CLI session directory must be accessible only to the current user.");
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await secureDirectory(dirname(directory));
  await secureDirectory(directory);
}

async function readSession(file: string, apiOrigin: string, authOrigin: string): Promise<SavedSession | null> {
  await ensurePrivateDirectory(dirname(file));
  let info;
  try { info = await lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (info.isSymbolicLink() || !info.isFile() || info.size > 65_536) throw new Error("The saved CLI session file is invalid; run auth logout and sign in again.");
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("The saved CLI session must belong to the current user.");
    if ((info.mode & 0o077) !== 0) throw new Error("The saved CLI session has unsafe permissions; run auth logout and sign in again.");
  }
  let value: unknown;
  try { value = JSON.parse(await readFile(file, "utf8")); }
  catch { throw new Error("The saved CLI session is unreadable; run auth logout and sign in again."); }
  const checked = savedSession.safeParse(value);
  if (!checked.success || checked.data.apiOrigin !== apiOrigin || checked.data.authOrigin !== authOrigin) {
    throw new Error("The saved CLI session is invalid for this deployment; run auth logout and sign in again.");
  }
  return checked.data;
}

async function writeSession(file: string, value: SavedSession): Promise<void> {
  const directory = dirname(file);
  await ensurePrivateDirectory(directory);
  try {
    const existing = await lstat(file);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("The saved CLI session path is unsafe.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  try {
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    await rename(temporary, file);
    if (process.platform !== "win32") await chmod(file, 0o600);
  } finally { await rm(temporary, { force: true }); }
}

async function removeSession(file: string): Promise<boolean> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("The saved CLI session path is unsafe.");
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("The saved CLI session has unsafe permissions; remove it manually after review.");
    await rm(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function sessionValue(session: AuthSession, apiOrigin: string, authOrigin: string, now: number): SavedSession {
  const expiresAt = session.expires_at ?? Math.floor(now / 1000) + session.expires_in;
  return savedSession.parse({
    version: 1, apiOrigin, authOrigin, accessToken: session.access_token,
    refreshToken: session.refresh_token, expiresAt,
  });
}

async function promptCredentials(): Promise<{ email: string; password: string }> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Supabase login requires an interactive terminal. For automation, set APP_API_TOKEN.");
  }
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  let email = "";
  try { email = await reader.question("Email: "); }
  finally { reader.close(); }

  process.stdout.write("Password: ");
  const input = process.stdin;
  input.setRawMode(true);
  input.resume();
  const decoder = new StringDecoder("utf8");
  let password = "";
  try {
    password = await new Promise<string>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        for (const character of decoder.write(chunk)) {
          if (character === "\r" || character === "\n") { cleanup(); resolve(password); return; }
          if (character === "\u0003" || character === "\u0004") { cleanup(); reject(new Error("Login cancelled.")); return; }
          if (character === "\u007f" || character === "\b") password = Array.from(password).slice(0, -1).join("");
          else if (character >= " " && character !== "\u007f") password += character;
        }
      };
      const cleanup = () => input.removeListener("data", onData);
      input.on("data", onData);
    });
  } finally {
    input.setRawMode(false);
    input.pause();
    process.stdout.write("\n");
  }
  return { email: email.trim(), password };
}

export async function runCliAuth(args: string[], env: Record<string, string | undefined> = process.env,
  dependencies: CliAuthDependencies = {}): Promise<unknown> {
  const [action, ...extra] = args;
  if (!action || action === "help") return {
    auth: "npm run app -- auth <login | status | logout> (Supabase user session; login stores a private per-deployment refresh session)",
  };
  if (extra.length || !["login", "status", "logout"].includes(action)) throw new Error("Use auth login, auth status, or auth logout.");

  const apiOrigin = apiOriginFrom(env);
  if (action === "status" && env.APP_API_TOKEN?.trim()) return { status: "authenticated", source: "APP_API_TOKEN", apiOrigin };
  const directory = sessionDirectory(env, dependencies.configRoot);
  const settings = authConfiguration(env);
  const file = sessionFile(apiOrigin, settings.url, directory);
  const now = dependencies.now ?? Date.now;
  const makeClient = dependencies.createClient ?? defaultClient;

  if (action === "status") {
    const current = await readSession(file, apiOrigin, settings.url);
    if (!current) return { status: "signed-out", apiOrigin };
    const expired = current.expiresAt <= Math.floor(now() / 1000);
    return { status: expired ? "expired" : "authenticated", source: "saved-session", expiresAt: current.expiresAt, apiOrigin };
  }

  if (action === "login") {
    if (env.APP_API_TOKEN?.trim()) throw new Error("APP_API_TOKEN takes precedence. Unset it before creating a saved Supabase session.");
    if (await readSession(file, apiOrigin, settings.url)) throw new Error("A saved session already exists for this deployment. Run auth logout before switching accounts.");
    const input = await (dependencies.promptCredentials ?? promptCredentials)();
    const email = z.string().email().safeParse(input.email.trim());
    if (!email.success || !input.password) throw new Error("Provide a valid email and password in the interactive prompts.");
    const client = makeClient(settings.url, settings.publishableKey);
    let password = input.password;
    try {
      const { data, error } = await client.auth.signInWithPassword({ email: email.data, password });
      if (error || !data.session) throw new Error("Supabase sign-in failed. Check the account and Auth project settings.");
      const current = sessionValue(data.session, apiOrigin, settings.url, now());
      await writeSession(file, current);
      return { status: "authenticated", source: "saved-session", expiresAt: current.expiresAt, apiOrigin };
    } finally { password = ""; input.password = ""; }
  }

  const current = await readSession(file, apiOrigin, settings.url);
  if (!current) return { status: "signed-out", apiOrigin };
  const client = makeClient(settings.url, settings.publishableKey);
  let remoteRevoked = false;
  try {
    const { error: setError } = await client.auth.setSession({ access_token: current.accessToken, refresh_token: current.refreshToken });
    if (!setError) {
      const { error } = await client.auth.signOut({ scope: "local" });
      remoteRevoked = !error;
    }
  } catch { remoteRevoked = false; }
  await removeSession(file);
  return { status: "signed-out", savedSessionRemoved: true, remoteRevoked, apiOrigin };
}

export async function cliAccessToken(env: Record<string, string | undefined> = process.env,
  dependencies: CliAuthDependencies = {}): Promise<string | null> {
  const configuredToken = env.APP_API_TOKEN?.trim();
  if (configuredToken) return configuredToken;
  const apiOrigin = apiOriginFrom(env);
  let settings;
  try { settings = authConfiguration(env); }
  catch { return null; }
  const directory = sessionDirectory(env, dependencies.configRoot);
  const file = sessionFile(apiOrigin, settings.url, directory);
  const current = await readSession(file, apiOrigin, settings.url);
  if (!current) return null;
  if (current.expiresAt > Math.floor((dependencies.now ?? Date.now)() / 1000) + 60) return current.accessToken;

  const client = (dependencies.createClient ?? defaultClient)(settings.url, settings.publishableKey);
  const { data, error } = await client.auth.refreshSession({ refresh_token: current.refreshToken });
  if (error || !data.session) throw new Error("The saved Supabase session expired or was revoked. Run npm run app -- auth login.");
  const refreshed = sessionValue(data.session, apiOrigin, settings.url, (dependencies.now ?? Date.now)());
  await writeSession(file, refreshed);
  return refreshed.accessToken;
}
