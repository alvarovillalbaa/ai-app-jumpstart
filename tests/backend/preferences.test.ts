import { expect,it } from "vitest";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqlitePreferenceStore } from "../../lib/preferences/sqlite";
import { preferenceContract } from "../contracts/preferences";

preferenceContract("SQLite",async () => sqlitePreferenceStore(":memory:"));
it("retains account preferences when reconnecting without changing defaults for another account",async () => {
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-preferences-")),path = join(directory,"app.sqlite"),owner = { tenant: "org",subject: "alice" };
  try {
    const first = sqlitePreferenceStore(path),saved = await first.update(owner,{ revision: 0,theme: "dark" });await first.close();
    const reopened = sqlitePreferenceStore(path);
    try { expect(await reopened.get(owner)).toEqual(saved);expect((await reopened.get({ ...owner,subject: "bob" })).revision).toBe(0); }
    finally { await reopened.close(); }
  } finally { await rm(directory,{ recursive: true,force: true }); }
});
