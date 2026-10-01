import { ConvexBackend } from "../data/convex-client";
import { preferences,preferenceOwner,preferencePatch,type PreferenceStore } from "./contract";

export function convexPreferenceStore(url: string,secret: string,request: typeof fetch = fetch): PreferenceStore {
  const backend = new ConvexBackend(url,secret,request);
  return { get: async owner => backend.call("preferences.get",preferenceOwner.parse(owner),preferences),
    update: async (owner,patch) => backend.call("preferences.update",{ ...preferenceOwner.parse(owner),patch: preferencePatch.parse(patch) },preferences.nullable()),
    async close() {},
  };
}
