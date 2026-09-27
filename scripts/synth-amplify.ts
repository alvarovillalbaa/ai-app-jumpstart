import { App } from "aws-cdk-lib";
import type { DeployManifest } from "@aws-amplify/hosting";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { amplifyConfig } from "../lib/deploy/amplify-config";
import { JumpstartAmplifyStack } from "../lib/deploy/amplify-stack";

try {
  if (process.argv.length !== 4 || process.argv[2] !== "--config") throw new Error("Usage: npm run synth:amplify -- --config FILE.json");
  if (existsSync("cdk.out")) throw new Error("Move the existing cdk.out review artifact before synthesizing again.");
  const config = amplifyConfig(JSON.parse(readFileSync(resolve(process.argv[3]), "utf8")));
  const metadata = JSON.parse(readFileSync(".amplify-build/build.json", "utf8"));
  if (metadata.eveOrigin !== config.eveOrigin) throw new Error("Rebuild Amplify with the configured Eve origin before synthesis.");
  const manifest = JSON.parse(readFileSync(".amplify-build/manifest.json", "utf8")) as DeployManifest;
  mkdirSync("cdk.out", { mode: 0o700 });
  const app = new App({ outdir: "cdk.out", context: { "@aws-cdk/core:checkSecretUsage": true } });
  new JumpstartAmplifyStack(app, config, manifest);
  app.synth();
  console.log("Offline Amplify assembly written to cdk.out. No AWS resources were created; review it and complete hosted acceptance before release.");
} catch (error) {
  // Parsing errors can include input; keep JSON and filesystem diagnostics private.
  const message = error instanceof Error ? error.message : "";
  console.error(/^(Amplify|Invalid Amplify|Usage:|Move the|Rebuild|Use the|Unexpected|Replace the Amplify|Set only|Disabled chat)/.test(message)
    ? message : "Amplify synthesis failed. Check the config, built artifact and native construct diagnostics without printing private values.");
  process.exitCode = 1;
}
