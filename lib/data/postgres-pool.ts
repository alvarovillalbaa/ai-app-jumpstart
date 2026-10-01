import { createHash } from "node:crypto";
import { Pool } from "pg";

type PoolEntry = { pool: Pool; references: number };
type Registry = Map<string,PoolEntry>;
type PoolGlobal = typeof globalThis & { __aiAppJumpstartPostgresPools?: Registry };

const registryKey = "__aiAppJumpstartPostgresPools" as const;

function registry(): Registry {
  const root = globalThis as PoolGlobal;
  return root[registryKey] ??= new Map();
}

export function acquirePostgresPool(connectionString: string,max: number = 5) {
  if (!connectionString) throw new Error("A PostgreSQL connection string is required.");
  if (!Number.isInteger(max) || max < 1 || max > 50) throw new Error("PostgreSQL pool maximum must be an integer from 1 through 50.");

  const key = `${createHash("sha256").update(connectionString).digest("hex")}:${max}`;
  const pools = registry();
  let entry = pools.get(key);
  if (!entry) {
    const pool = new Pool({ connectionString,max,connectionTimeoutMillis: 5000,idleTimeoutMillis: 10_000,statement_timeout: 10_000 });
    pool.on("error",() => console.error(JSON.stringify({ event: "postgres_pool_error" })));
    entry = { pool,references: 0 };
    pools.set(key,entry);
  }
  entry.references += 1;

  let released = false;
  return {
    pool: entry.pool,
    async release() {
      if (released) return;
      released = true;
      entry!.references -= 1;
      if (entry!.references === 0 && pools.get(key) === entry) {
        pools.delete(key);
        await entry!.pool.end();
      }
    },
  };
}
