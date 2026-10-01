import { cancelStartContract } from "../contracts/cancel-start";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { sqliteBudgetStore } from "../../lib/budgets/sqlite";

cancelStartContract("SQLite",async () => sqliteAccessStore(":memory:"),async () => sqliteBudgetStore(":memory:"));
