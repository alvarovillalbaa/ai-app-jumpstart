import { z } from "zod";
import type { Owner } from "../data/contract";

export const preferenceValues = z.object({ theme: z.enum(["system","light","dark"]),soundEnabled: z.boolean(),soundVolume: z.number().min(0).max(1) }).strict();
export const preferences = preferenceValues.extend({ schemaVersion: z.literal(1),revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),updatedAt: z.iso.datetime().nullable() }).strict();
export const preferencePatch = preferenceValues.partial().extend({ revision: preferences.shape.revision.max(Number.MAX_SAFE_INTEGER-1) }).strict()
  .refine(value => value.theme !== undefined || value.soundEnabled !== undefined || value.soundVolume !== undefined,"Choose at least one preference.");
export type Preferences = z.infer<typeof preferences>;
export type PreferencePatch = z.infer<typeof preferencePatch>;
export const defaultPreferences: Preferences = { schemaVersion: 1,revision: 0,updatedAt: null,theme: "system",soundEnabled: false,soundVolume: 0.5 };
export const preferenceOwner = z.object({ tenant: z.string().min(1).max(200),subject: z.string().min(1).max(200) }).strict();
export const preferenceCommand = z.discriminatedUnion("operation",[
  preferenceOwner.extend({ operation: z.literal("preferences.get") }).strict(),
  preferenceOwner.extend({ operation: z.literal("preferences.update"),patch: preferencePatch }).strict(),
]);
export interface PreferenceStore {
  get(owner: Owner): Promise<Preferences>;
  update(owner: Owner,patch: PreferencePatch): Promise<Preferences|null>;
  close(): Promise<void>;
}
