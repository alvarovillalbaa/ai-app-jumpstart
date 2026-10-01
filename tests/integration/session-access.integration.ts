import { sessionAccessContract } from "../contracts/session-access";
import { createSessionAccessStore } from "../../lib/agent-access/store";
if (!["postgres", "supabase", "convex"].includes(process.env.DATA_PROVIDER ?? "")) throw new Error("Use an explicitly configured disposable database.");
sessionAccessContract(process.env.DATA_PROVIDER!, createSessionAccessStore);
