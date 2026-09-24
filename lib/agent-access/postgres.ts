import { Pool } from "pg";
import { SqlSessionAccessStore } from "./sql-store";

export function postgresAccessStore(connectionString: string) {
  const pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10_000, statement_timeout: 10_000 });
  pool.on("error", () => console.error(JSON.stringify({ event: "session_access_pool_error" })));
  return new SqlSessionAccessStore({
    lockBinding: true,
    query: async (sql, parameters) => {
      let index = 0;
      return (await pool.query(sql.replace(/\?/g, () => `$${++index}`), parameters)).rows;
    },
    close: () => pool.end(),
  });
}
