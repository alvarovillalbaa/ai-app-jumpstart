import { cancelStartContract } from "../contracts/cancel-start";
import { createSessionAccessStore } from "../../lib/agent-access/store";
import { createBudgetStore } from "../../lib/budgets/store";

if (!["postgres","supabase","convex"].includes(process.env.DATA_PROVIDER ?? "")) throw new Error("Use an explicitly configured disposable database.");
cancelStartContract(process.env.DATA_PROVIDER!,createSessionAccessStore,createBudgetStore);
