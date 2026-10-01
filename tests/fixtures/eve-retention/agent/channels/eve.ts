import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  uploadPolicy: "disabled",
  auth: request => request.headers.get("authorization") === `Bearer ${process.env.TEST_RETENTION_TOKEN}`
    ? { authenticator: "retention-fixture",principalType: "user",principalId: "alice",attributes: {} } : null,
});
