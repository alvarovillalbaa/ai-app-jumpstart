import { defaultPreferences,preferences,preferenceOwner,preferencePatch,type PreferenceStore } from "./contract";
import type { AccessDatabase } from "../agent-access/sql-store";

export function sqlPreferenceStore(db: AccessDatabase): PreferenceStore {
  function view(row: unknown) {
    const value = row as { theme: string;sound_enabled: boolean|number;sound_volume: number;revision: number|string;updated_at: string };
    return preferences.parse({ schemaVersion: 1,theme: value.theme,soundEnabled: Boolean(value.sound_enabled),soundVolume: Number(value.sound_volume),revision: Number(value.revision),updatedAt: value.updated_at });
  }
  return {
    async get(owner) {
      const o = preferenceOwner.parse(owner),rows = await db.query("SELECT * FROM app_user_preferences WHERE tenant=? AND subject=?",[o.tenant,o.subject]);
      return rows.length ? view(rows[0]) : { ...defaultPreferences };
    },
    async update(owner,input) {
      const o = preferenceOwner.parse(owner),patch = preferencePatch.parse(input),at = new Date().toISOString();
      if (patch.revision === 0) {
        const rows = await db.query(`INSERT INTO app_user_preferences(tenant,subject,theme,sound_enabled,sound_volume,revision,updated_at)
          VALUES(?,?,?,?,?,1,?) ON CONFLICT(tenant,subject) DO NOTHING RETURNING *`,
        [o.tenant,o.subject,patch.theme ?? defaultPreferences.theme,Number(patch.soundEnabled ?? false),patch.soundVolume ?? defaultPreferences.soundVolume,at]);
        return rows.length ? view(rows[0]) : null;
      }
      const enabled = patch.soundEnabled === undefined ? null : Number(patch.soundEnabled);
      const rows = await db.query(`UPDATE app_user_preferences SET theme=coalesce(?,theme),sound_enabled=coalesce(?,sound_enabled),
        sound_volume=coalesce(?,sound_volume),revision=revision+1,updated_at=? WHERE tenant=? AND subject=? AND revision=? RETURNING *`,
      [patch.theme ?? null,enabled,patch.soundVolume ?? null,at,o.tenant,o.subject,patch.revision]);
      return rows.length ? view(rows[0]) : null;
    },
    close: () => db.close(),
  };
}
