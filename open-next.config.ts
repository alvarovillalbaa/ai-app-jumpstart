import type { OpenNextConfig } from "@opennextjs/aws/types/open-next.js";

// Amplify's self-managed construct uses API Gateway REST with streaming. Its
// adapter applies the corresponding framing patch to this OpenNext bundle.
const config: OpenNextConfig = {
  default: { override: { wrapper: "aws-lambda-streaming", converter: "aws-apigw-v1" } },
  buildCommand: "npm run build",
  dangerous: { middlewareHeadersOverrideNextConfigHeaders: true },
};
export default config;
