import { sqliteAccessStore } from "../../../../../lib/agent-access/sqlite";
let store: ReturnType<typeof sqliteAccessStore> | undefined;
export function accessStore() { return store ??= sqliteAccessStore(process.env.SQLITE_PATH!); }
export function signing() { return { audience: "isolated-session-runtime", activeKey: "fixture", keys: { fixture: process.env.TEST_SIGNING_KEY! } }; }
