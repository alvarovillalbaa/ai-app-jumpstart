import { defineDynamic,defineMcpClientConnection } from "eve/connections";
import { referenceMcpUrl } from "../../lib/reference-mcp/config";

export default defineDynamic({ events: {
  "turn.started": () => {
    const url = referenceMcpUrl();
    if (!url) return null;
    return defineMcpClientConnection({ url,
      description: "Read an operator-provided local reference catalog. This shared development data is not a user's private account or a live external source.",
      tools: { allow: ["catalog_list","catalog_get"] },
    });
  },
} });
