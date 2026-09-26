import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateCloudManifest,type CloudProvider } from "../lib/deploy/cloud-config";

const examples: Record<CloudProvider,string> = {
  aws: "deploy/aws/task-definition.example.json",
  azure: "deploy/azure/container-app.example.json",
  gcp: "deploy/gcp/service.example.json",
};
const usage = "Usage: npm run check:cloud-config -- --provider aws|azure|gcp --file PATH [--template] | --templates";

async function readManifest(path: string) {
  let text: string;
  try { text = await readFile(resolve(path),"utf8"); }
  catch { throw new Error("Could not read the selected manifest file."); }
  try { return JSON.parse(text) as unknown; }
  catch { throw new Error("Manifest JSON is invalid."); }
}

async function main(args: string[]) {
  if (args.length === 1 && args[0] === "--templates") {
    for (const provider of Object.keys(examples) as CloudProvider[]) {
      validateCloudManifest(provider,await readManifest(examples[provider]),true);
    }
    console.log("AWS, Azure and GCP cloud manifest templates passed structural preflight.");
    return;
  }
  const template = args.includes("--template"),options = args.filter(arg => arg !== "--template");
  if (options.length !== 4 || options[0] !== "--provider" || options[2] !== "--file" ||
      !["aws","azure","gcp"].includes(options[1])) throw new Error(usage);
  const provider = options[1] as CloudProvider;
  const result = validateCloudManifest(provider,await readManifest(options[3]),template);
  console.log(JSON.stringify({ provider: result.provider,dataProvider: result.dataProvider,
    secretReferences: result.secretReferences,template }));
  if (template) console.log("Template mode permits placeholders; rerun without --template on the filled deployment file.");
}

main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : "Cloud manifest preflight failed.");
  process.exitCode = 1;
});
