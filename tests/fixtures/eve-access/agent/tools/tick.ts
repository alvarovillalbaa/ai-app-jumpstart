import { defineTool } from "eve/tools";
import { z } from "zod";
export default defineTool({ description: "A free deterministic fixture tool.", inputSchema: z.object({}), execute: async () => ({ ok: true }) });
