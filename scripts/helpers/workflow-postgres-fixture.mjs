import EmbeddedPostgres from "embedded-postgres";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { once } from "node:events";

export async function workflowPostgresFixture() {
  const directory = await mkdtemp(join(tmpdir(), "jumpstart-workflow-db-"));
  const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const password = randomBytes(24).toString("hex");
  const database = new EmbeddedPostgres({ databaseDir: join(directory, "data"), user: "workflow_test", password, port,
    persistent: true, authMethod: "scram-sha-256", createPostgresUser: false,
    postgresFlags: ["-h", "127.0.0.1", "-k", directory], onLog() {}, onError() {},
  });
  const stop = async () => { await database.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); };
  try {
    await database.initialise(); await database.start(); await database.createDatabase("workflow_test");
    return { url: `postgresql://workflow_test:${password}@127.0.0.1:${port}/workflow_test`, stop };
  } catch (error) { await stop(); throw error; }
}
