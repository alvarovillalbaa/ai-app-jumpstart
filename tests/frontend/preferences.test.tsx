// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { act,cleanup,fireEvent,render,screen,waitFor } from "@testing-library/react";
import { PreferencesProvider } from "../../app/_components/preferences-provider";
import { ThemeSelector } from "../../app/_components/theme-selector";
import { SoundPreferences } from "../../app/_components/sound-preferences";
import { RecordsPanel } from "../../app/_components/records-panel";
import { defaultPreferences } from "../../lib/preferences/contract";

const mock = vi.hoisted(() => ({ setTheme: vi.fn(),play: vi.fn(),setEnabled: vi.fn(),setVolume: vi.fn(),bind: vi.fn(),
  session: { user: { id: "alice",role: "authenticated",is_anonymous: false },access_token: "alice-fresh-token" } as { user: { id: string;role: string;is_anonymous: boolean };access_token: string }|null,
  listener: (_event: string,_session: unknown) => { void _event;void _session; },
}));
vi.mock("next-themes",() => ({ useTheme: () => ({ setTheme: mock.setTheme }) }));
vi.mock("cuelume",() => ({ play: mock.play,setEnabled: mock.setEnabled,setVolume: mock.setVolume,bind: mock.bind }));
vi.mock("../../lib/auth/browser",() => {
  const client = { auth: { getSession: async () => ({ data: { session: mock.session },error: null }),
    onAuthStateChange: (fn: typeof mock.listener) => { mock.listener = fn;return { data: { subscription: { unsubscribe() {} } } }; },
  } };return { browserAuth: () => client };
});
const settings = { url: "https://auth.example",publishableKey: "sb_publishable_fixture" };
const saved = { ...defaultPreferences,revision: 1,updatedAt: "2026-09-27T10:00:00.000Z",theme: "dark" as const,soundEnabled: true,soundVolume: 0.25 };
function controls(account = true) { render(<PreferencesProvider settings={account ? settings : null}><ThemeSelector /><SoundPreferences /></PreferencesProvider>); }
beforeEach(() => { localStorage.clear();mock.session = { user: { id: "alice",role: "authenticated",is_anonymous: false },access_token: "alice-fresh-token" }; });
afterEach(() => { cleanup();vi.unstubAllGlobals(); });

it("hydrates server preferences without writing device values to the account or playing a sound",async () => {
  localStorage.setItem("jumpstart-theme","light");
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(done => { resolve = done; }));vi.stubGlobal("fetch",fetcher);
  controls();
  expect(screen.getByLabelText("Theme")).toBeDisabled();
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  await act(async () => resolve(Response.json(saved)));
  await waitFor(() => expect(screen.getByLabelText("Theme")).toHaveValue("dark"));
  expect(fetcher.mock.calls[0][0]).toBe("/api/v1/account/preferences");
  expect(fetcher.mock.calls[0][1]?.method).toBeUndefined();
  expect(JSON.parse(localStorage.getItem("jumpstart-device-preferences-v1")!)).toEqual({ theme: "light",soundEnabled: false,soundVolume: 0.5 });
  expect(mock.play).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{ name: "Test sound" }));expect(mock.play).toHaveBeenCalledWith("success");
});

it("preserves the original device choice across an account theme cache and full reload",async () => {
  localStorage.setItem("jumpstart-theme","light");
  vi.stubGlobal("fetch",vi.fn(async () => Response.json(saved)));
  controls();await waitFor(() => expect(screen.getByLabelText("Theme")).toHaveValue("dark"));
  // next-themes writes its separate rendering cache when applying dark.
  localStorage.setItem("jumpstart-theme","dark");cleanup();
  controls();await waitFor(() => expect(screen.getByLabelText("Theme")).toHaveValue("dark"));
  mock.session = null;act(() => mock.listener("SIGNED_OUT",null));
  await waitFor(() => expect(screen.getByLabelText("Theme")).toHaveValue("light"));
  expect(screen.getByLabelText("Enable sounds")).not.toBeChecked();
});

it("uses the current revision and fresh credential, retains conflicts and refreshes without another write",async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(saved)).mockResolvedValueOnce(Response.json({}, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ ...saved,revision: 2,theme: "system" }));vi.stubGlobal("fetch",fetcher);
  controls();await waitFor(() => expect(screen.getByLabelText("Theme")).toBeEnabled());
  mock.session!.access_token = "refreshed-token";
  fireEvent.change(screen.getByLabelText("Theme"),{ target: { value: "light" } });
  expect(await screen.findByRole("alert")).toHaveTextContent("another device");
  expect(screen.getByLabelText("Theme")).toHaveValue("dark");
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ revision: 1,theme: "light" });
  expect(new Headers(fetcher.mock.calls[1][1].headers).get("authorization")).toBe("Bearer refreshed-token");
  fireEvent.click(screen.getByRole("button",{ name: "Refresh preferences" }));
  await waitFor(() => expect(screen.getByLabelText("Theme")).toHaveValue("system"));
  expect(fetcher.mock.calls[2][1].method).toBeUndefined();expect(mock.play).not.toHaveBeenCalled();
});

it("ignores a delayed account write after switching users and restores the device preference on sign-out",async () => {
  localStorage.setItem("jumpstart-device-preferences-v1",JSON.stringify({ theme: "light",soundEnabled: false,soundVolume: 0.5 }));
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(saved)).mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }))
    .mockResolvedValueOnce(Response.json(defaultPreferences));vi.stubGlobal("fetch",fetcher);
  controls();await waitFor(() => expect(screen.getByLabelText("Theme")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("Theme"),{ target: { value: "light" } });
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  mock.session = { user: { id: "bob",role: "authenticated",is_anonymous: false },access_token: "bob-token" };
  act(() => mock.listener("SIGNED_IN",mock.session));
  await waitFor(() => expect(screen.getByLabelText("Theme")).toHaveValue("system"));
  await act(async () => resolve(Response.json({ ...saved,revision: 2,theme: "dark" })));
  expect(screen.getByLabelText("Theme")).toHaveValue("system");
  expect(screen.getByLabelText("Enable sounds")).not.toBeChecked();
  mock.session = null;act(() => mock.listener("SIGNED_OUT",null));
  await waitFor(() => expect(screen.getByLabelText("Theme")).toHaveValue("light"));
  expect(fetcher).toHaveBeenCalledTimes(3);expect(mock.play).not.toHaveBeenCalled();
});

it("starts device sounds muted, persists only explicit choices and saves volume once",async () => {
  const fetcher = vi.fn();vi.stubGlobal("fetch",fetcher);controls(false);
  await waitFor(() => expect(screen.getByLabelText("Enable sounds")).toBeEnabled());
  expect(screen.getByLabelText("Enable sounds")).not.toBeChecked();
  fireEvent.change(screen.getByLabelText("Sound volume"),{ target: { value: "0.75" } });
  expect(localStorage.getItem("jumpstart-device-preferences-v1")).toBeNull();
  fireEvent.click(screen.getByRole("button",{ name: "Save volume" }));
  await waitFor(() => expect(JSON.parse(localStorage.getItem("jumpstart-device-preferences-v1")!)).toMatchObject({ soundVolume: 0.75,soundEnabled: false }));
  expect(fetcher).not.toHaveBeenCalled();expect(mock.play).not.toHaveBeenCalled();
});

it.each([false,true])("plays a confirmed record cue only when enabled (%s), and never for reads",async soundEnabled => {
  const record = { id: "one",title: "Created note",content: "Content",revision: 1 };
  const fetcher = vi.fn<typeof fetch>(async (url,init) => String(url).includes("preferences") ? Response.json({ ...saved,soundEnabled }) :
    init?.method === "POST" ? Response.json(record,{ status: 201 }) : Response.json({ items: [record],nextCursor: null }));
  vi.stubGlobal("fetch",fetcher);
  render(<PreferencesProvider settings={settings}><SoundPreferences /><RecordsPanel credential={async () => "alice-token"} /></PreferencesProvider>);
  await waitFor(() => expect(screen.getByLabelText("Enable sounds")).toBeEnabled());
  fireEvent.click(screen.getByRole("button",{ name: "Load records" }));
  fireEvent.change(await screen.findByLabelText("Title"),{ target: { value: record.title } });
  expect(mock.play).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{ name: "Create record" }));
  await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  expect(mock.play).toHaveBeenCalledTimes(soundEnabled ? 1 : 0);
  fireEvent.click(screen.getByRole("button",{ name: /^Refresh$/ }));
  await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  expect(mock.play).toHaveBeenCalledTimes(soundEnabled ? 1 : 0);
});

it("suppresses a late confirmed record cue after an account change or unmount",async () => {
  let complete!: (response: Response) => void;
  vi.stubGlobal("fetch",vi.fn<typeof fetch>(async (url,init) => String(url).includes("preferences") ? Response.json(saved) :
    init?.method === "POST" ? new Promise<Response>(resolve => { complete = resolve; }) : Response.json({ items: [],nextCursor: null })));
  const view = render(<PreferencesProvider settings={settings}><SoundPreferences /><RecordsPanel credential={async () => "alice-token"} /></PreferencesProvider>);
  await waitFor(() => expect(screen.getByLabelText("Enable sounds")).toBeEnabled());
  fireEvent.click(screen.getByRole("button",{ name: "Load records" }));
  fireEvent.change(await screen.findByLabelText("Title"),{ target: { value: "Delayed" } });
  fireEvent.click(screen.getByRole("button",{ name: "Create record" }));
  await waitFor(() => expect(complete).toBeDefined());
  mock.session = { user: { id: "bob",role: "authenticated",is_anonymous: false },access_token: "bob-token" };
  act(() => mock.listener("SIGNED_IN",mock.session));
  await waitFor(() => expect(screen.getByLabelText("Enable sounds")).toBeEnabled());
  await act(async () => complete(Response.json({ id: "old" },{ status: 201 })));
  expect(mock.play).not.toHaveBeenCalled();
  const previousCompletion = complete;
  fireEvent.change(screen.getByLabelText("Title"),{ target: { value: "Unmounted" } });
  fireEvent.click(screen.getByRole("button",{ name: "Create record" }));
  await waitFor(() => expect(complete).not.toBe(previousCompletion));
  view.unmount();await act(async () => complete(Response.json({ id: "new" },{ status: 201 })));
  expect(mock.play).not.toHaveBeenCalled();
});
