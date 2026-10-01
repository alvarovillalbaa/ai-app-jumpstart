import { acquirePostgresPool } from "../data/postgres-pool";
import { SqlSessionAccessStore } from "./sql-store";

export function postgresAccessStore(connectionString: string,poolMax = 5) {
  const { pool,release } = acquirePostgresPool(connectionString,poolMax);
  return new SqlSessionAccessStore({
    lockBinding: true,
    accountFenceTable: "app_private.account_fences",
    query: async (sql, parameters) => {
      let index = 0;
      return (await pool.query(sql.replace(/\?/g, () => `$${++index}`), parameters)).rows;
    },
    close: release,
  });
}
