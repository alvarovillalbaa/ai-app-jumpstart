import { randomUUID } from "node:crypto";
import { expect,it } from "vitest";
import { acquirePostgresPool } from "../../lib/data/postgres-pool";

it("reuses one bounded pool per process and closes it after its final lease", async () => {
  const connectionString = `postgresql://app:secret@pool-test.invalid/app?case=${randomUUID()}`;
  const first = acquirePostgresPool(connectionString,2);
  const second = acquirePostgresPool(connectionString,2);
  expect(second.pool).toBe(first.pool);

  await first.release();
  const third = acquirePostgresPool(connectionString,2);
  expect(third.pool).toBe(first.pool);
  await second.release();
  await third.release();
  await third.release();

  const next = acquirePostgresPool(connectionString,2);
  expect(next.pool).not.toBe(first.pool);
  const differentlyBounded = acquirePostgresPool(connectionString,1);
  expect(differentlyBounded.pool).not.toBe(next.pool);
  await Promise.all([next.release(),differentlyBounded.release()]);
});

it("rejects empty connections and unsafe pool maxima before opening sockets", () => {
  expect(() => acquirePostgresPool("",1)).toThrow("A PostgreSQL connection string is required.");
  for (const max of [0,51,1.5,Number.NaN]) expect(() => acquirePostgresPool("postgresql://db.example/app",max)).toThrow("PostgreSQL pool maximum");
});
