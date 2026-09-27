import { preferenceContract } from "../contracts/preferences";
import { createPreferenceStore } from "../../lib/preferences/store";
if (!["postgres","supabase","convex"].includes(process.env.DATA_PROVIDER ?? "")) throw new Error("Use a disposable migrated provider for preference contracts.");
preferenceContract(process.env.DATA_PROVIDER!,createPreferenceStore);
