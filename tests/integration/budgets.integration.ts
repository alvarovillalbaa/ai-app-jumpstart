import { budgetContract } from "../contracts/budgets";
import { createBudgetStore } from "../../lib/budgets/store";
if (!["postgres","supabase","convex"].includes(process.env.DATA_PROVIDER ?? "")) throw new Error("Use an explicitly configured disposable database.");
budgetContract(process.env.DATA_PROVIDER!, createBudgetStore);
