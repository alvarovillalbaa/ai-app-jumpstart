import { defineHook } from "eve/hooks";
import { appendFile } from "node:fs/promises";

// Observe real native events without introducing another Workflow run.
export default defineHook({ events: {
  async "*"(event) { await appendFile(process.env.TEST_RETENTION_RECEIPTS!,`${event.type}\n`); },
} });
