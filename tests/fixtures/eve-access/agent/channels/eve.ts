import { eveChannel } from "eve/channels/eve";
import { accessStore, signing } from "#lib/access.ts";
import { sessionAuthorizer } from "../../../../../lib/agent-access/authorize";

export default eveChannel({
  uploadPolicy: "disabled",
  auth: request => sessionAuthorizer({ store: accessStore(), signing: signing(), identify: async req => {
    const header = req.headers.get("authorization");
    if (header === `Bearer ${process.env.TEST_ALICE_TOKEN}`) return { tenant: "fixture", subject: "alice" };
    if (header === `Bearer ${process.env.TEST_BOB_TOKEN}`) return { tenant: "fixture", subject: "bob" };
    if (process.env.TEST_CAROL_TOKEN && header === `Bearer ${process.env.TEST_CAROL_TOKEN}`) return { tenant: "fixture", subject: "carol" };
    return null;
  } })(request),
});
