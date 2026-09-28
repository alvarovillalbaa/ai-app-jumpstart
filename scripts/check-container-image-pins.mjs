import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const digest = /@sha256:[0-9a-f]{64}$/;
const references = new Map();
let checked = 0;

function check(reference, location) {
  if (!digest.test(reference)) throw new Error(`${location}: external image must have a SHA-256 digest`);
  const [tag] = reference.split("@sha256:");
  const previous = references.get(tag);
  if (previous && previous !== reference) {
    throw new Error(`${location}: ${tag} has a different digest elsewhere in the repository`);
  }
  references.set(tag, reference);
  checked++;
}

async function dockerfile(path) {
  const lines = (await readFile(join(root, path), "utf8")).split(/\r?\n/);
  const stages = new Set();
  for (const [index, line] of lines.entries()) {
    const location = `${path}:${index + 1}`;
    if (/^# syntax=/.test(line)) {
      check(line.slice("# syntax=".length).trim(), location);
      continue;
    }
    if (!/^\s*FROM\s/i.test(line)) continue;
    const match = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(line);
    if (!match) throw new Error(`${location}: unsupported FROM instruction`);
    const [, source, stage] = match;
    if (!stages.has(source) && source !== "scratch") check(source, location);
    if (stage) stages.add(stage);
  }
}

async function compose(path) {
  const lines = (await readFile(join(root, path), "utf8")).split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!/^\s*image:/.test(line)) continue;
    const match = /^\s*image:\s*([\w./:@-]+)\s*(?:#.*)?$/.exec(line);
    if (!match) throw new Error(`${path}:${index + 1}: unsupported image reference`);
    check(match[1], `${path}:${index + 1}`);
  }
}

const rootFiles = await readdir(root);
const deployFiles = await readdir(join(root, "deploy"));
for (const path of [...rootFiles.filter(name => name.startsWith("Dockerfile")),
  ...deployFiles.filter(name => name.endsWith(".Dockerfile")).map(name => `deploy/${name}`)]) {
  await dockerfile(path);
}
for (const path of rootFiles.filter(name => /^compose.*\.ya?ml$/.test(name))) await compose(path);

const authHarness = await readFile(join(root, "scripts/test-auth.mjs"), "utf8");
const harnessImage = /runContainer\("postgres",\s*"([^"]+)"/.exec(authHarness)?.[1];
if (!harnessImage) throw new Error("scripts/test-auth.mjs: missing PostgreSQL image reference");
check(harnessImage, "scripts/test-auth.mjs");

if (!references.has("node:24-bookworm-slim") || !references.has("postgres:17-bookworm")) {
  throw new Error("Expected production Node and PostgreSQL images were not found");
}
console.log(`Container image pins passed: ${checked} references across ${references.size} image tags.`);
