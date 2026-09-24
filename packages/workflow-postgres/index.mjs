import { createWorld as postgresWorld } from "@workflow/world-postgres";
import { postgresWorkflowSettings } from "./config.mjs";

/** Eve owns worker start/close through its generated Nitro lifecycle plugin. */
export function createWorld() {
  return postgresWorld(postgresWorkflowSettings());
}
