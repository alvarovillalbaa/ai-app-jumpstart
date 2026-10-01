import { afterEach,beforeEach,describe,expect,it } from "vitest";
import { randomUUID } from "node:crypto";
import { defaultPreferences,type PreferenceStore } from "../../lib/preferences/contract";

export function preferenceContract(name: string,factory: () => Promise<PreferenceStore>) {
  describe(`Preferences: ${name}`,() => {
    let store: PreferenceStore,owner: { tenant: string;subject: string };
    beforeEach(async () => { store = await factory();owner = { tenant: randomUUID(),subject: randomUUID() }; });
    afterEach(async () => store?.close());
    it("reads defaults without reserving a revision and isolates both owner fields",async () => {
      expect(await store.get(owner)).toEqual(defaultPreferences);
      const saved = await store.update(owner,{ revision: 0,theme: "dark",soundEnabled: true,soundVolume: 0.25 });
      expect(saved).toMatchObject({ schemaVersion: 1,revision: 1,theme: "dark",soundEnabled: true,soundVolume: 0.25 });
      expect(saved?.updatedAt).toEqual(expect.any(String));
      expect(await store.get(owner)).toEqual(saved);
      for (const other of [{ ...owner,subject: "other" },{ ...owner,tenant: "other" }]) expect(await store.get(other)).toEqual(defaultPreferences);
    });
    it("commits one concurrent first write and rejects stale updates without altering other fields",async () => {
      const first = await Promise.all(["dark","light"].map(theme => store.update(owner,{ revision: 0,theme: theme as "dark"|"light" })));
      expect(first.filter(Boolean)).toHaveLength(1);
      const original = await store.get(owner);
      const writes = await Promise.all([true,false].map(soundEnabled => store.update(owner,{ revision: 1,soundEnabled })));
      expect(writes.filter(Boolean)).toHaveLength(1);
      const saved = await store.get(owner);
      expect(saved).toMatchObject({ revision: 2,theme: original.theme,soundVolume: original.soundVolume });
      expect(await store.update(owner,{ revision: 1,theme: "system" })).toBeNull();
      expect(await store.get(owner)).toEqual(saved);
      expect(await store.update(owner,{ revision: 2,soundVolume: 0,theme: "system",soundEnabled: false })).toMatchObject({ revision: 3,soundEnabled: false,soundVolume: 0,theme: "system" });
    });
    it("rejects owner injection and invalid preference fields before mutation",async () => {
      for (const patch of [{ revision: 0 },{ revision: 0,theme: "auto" },{ revision: 0,soundVolume: 1.01 },{ revision: 0,soundVolume: -1 },{ revision: 0,soundEnabled: "true" },{ revision: 0,theme: "dark",subject: "victim" }])
        await expect(store.update(owner,patch as never)).rejects.toBeDefined();
      expect(await store.get(owner)).toEqual(defaultPreferences);
    });
  });
}
