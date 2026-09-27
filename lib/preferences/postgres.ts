import { Pool } from "pg";
import { sqlPreferenceStore } from "./sql";

export function postgresPreferenceStore(connectionString: string) {
  const pool = new Pool({ connectionString,max: 5,connectionTimeoutMillis: 5000,idleTimeoutMillis: 10_000,statement_timeout: 10_000 });
  pool.on("error",() => console.error(JSON.stringify({ event: "preferences_pool_error" })));
  return sqlPreferenceStore({ lockBinding: true,query: async (sql,params) => {
    let index = 0;return (await pool.query(sql.replace(/\?/g,() => `$${++index}`),params)).rows;
  },close: () => pool.end() });
}
