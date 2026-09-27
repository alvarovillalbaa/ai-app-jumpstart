import { AgentUploadReader } from "../../lib/uploads/agent-reader";
import { getSessionAccessStore } from "../../lib/agent-access/store";
import { getUploadCatalog } from "../../lib/uploads/catalog-store";
import { createUploadObjects } from "../../lib/uploads/objects-store";
import { createUploadScanner } from "../../lib/uploads/scanner";
import { UploadService } from "../../lib/uploads/service";

export async function agentUploadReader() {
  return new AgentUploadReader(await getSessionAccessStore(),async owner => new UploadService(await getUploadCatalog(),
    createUploadObjects,{ ...owner,scopes: ["uploads:read","uploads:download"] },createUploadScanner));
}
