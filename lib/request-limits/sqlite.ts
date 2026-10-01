import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { limitInput,limitOwner,snapshotFromRow,windowResult,type RequestLimitStore } from "./contract";
import { installSqliteAccountFences } from "../account-closure/sqlite-fences";

export function sqliteRequestLimitStore(path: string,clock = Date.now): RequestLimitStore {
  if (path !== ":memory:") mkdirSync(dirname(path),{ recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS app_request_limits(tenant TEXT NOT NULL,subject TEXT NOT NULL,
      bucket INTEGER NOT NULL CHECK(bucket>=0 AND bucket%60000=0),counter INTEGER NOT NULL CHECK(counter BETWEEN 1 AND 10000),PRIMARY KEY(tenant,subject));`);
  installSqliteAccountFences(db,["app_request_limits"]);
  const claim = db.prepare(`INSERT INTO app_request_limits(tenant,subject,bucket,counter) VALUES(?,?,?,1)
    ON CONFLICT(tenant,subject) DO UPDATE SET bucket=max(app_request_limits.bucket,excluded.bucket),
      counter=CASE WHEN excluded.bucket>app_request_limits.bucket THEN 1 ELSE app_request_limits.counter+1 END
    WHERE excluded.bucket>app_request_limits.bucket OR app_request_limits.counter<? RETURNING bucket,counter`);
  const read = db.prepare("SELECT bucket,counter FROM app_request_limits WHERE tenant=? AND subject=?");
  return {
    async claim(owner,limit) {
      const input = limitInput.parse({ ...limitOwner.parse(owner),limit }),now = clock(),bucket = Math.floor(now/60000)*60000;
      const admitted = claim.get(input.tenant,input.subject,bucket,input.limit);
      const row = (admitted ?? read.get(input.tenant,input.subject)) as { bucket: number;counter: number };
      return windowResult(Boolean(admitted),row.counter,row.bucket,input.limit,now);
    },
    async snapshot(owner) {
      const input = limitOwner.parse(owner);
      const row = read.get(input.tenant,input.subject) as { bucket: number;counter: number } | undefined;
      return snapshotFromRow(row ?? null);
    },
    async health() { db.prepare("SELECT bucket FROM app_request_limits LIMIT 1").get(); },
    async close() { db.close(); },
  };
}
