import { recordContract } from "../contracts/records";
import { createRepository } from "../../lib/data/repository";
if (!["postgres", "supabase", "convex"].includes(process.env.DATA_PROVIDER ?? "")) {
  throw new Error("Set DATA_PROVIDER=postgres, supabase or convex and use a disposable migrated database. Missing configuration fails explicitly.");
}
recordContract(process.env.DATA_PROVIDER!, createRepository);
