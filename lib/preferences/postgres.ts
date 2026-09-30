import { acquirePostgresPool } from "../data/postgres-pool";
import { sqlPreferenceStore } from "./sql";

export function postgresPreferenceStore(connectionString: string,poolMax = 5) {
  const { pool,release } = acquirePostgresPool(connectionString,poolMax);
  return sqlPreferenceStore({ lockBinding: true,query: async (sql,params) => {
    let index = 0;return (await pool.query(sql.replace(/\?/g,() => `$${++index}`),params)).rows;
  },close: release });
}
