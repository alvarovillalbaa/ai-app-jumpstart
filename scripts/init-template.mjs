import { randomUUID } from "node:crypto";
import { rename,rm,writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readBoundedRegularFile,readBoundedRegularFileDetails } from "../lib/security/read-bounded-file.mjs";

const MAX_TEMPLATE_INPUT_BYTES = 16 * 1024 * 1024;
const readText = async path => (await readBoundedRegularFile(path,{ minBytes: 1,maxBytes: MAX_TEMPLATE_INPUT_BYTES })).toString("utf8");

const usage = `Initialize this copy of AI App Jumpstart.

Usage:
  npm run init:template -- --name "Acme Assistant" [--slug acme-assistant] [--apply]

The command previews changes by default. --apply writes project identity fields.`;

function parseArgs(args) {
  const options = { apply: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--apply") options.apply = true;
    else if (argument === "--name" || argument === "--slug") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      if (Object.hasOwn(options, argument.slice(2))) throw new Error(`${argument} may be supplied only once.`);
      options[argument.slice(2)] = value;
      index += 1;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function slugFromName(name) {
  return name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function replaceTypeScriptString(source, property, value, file) {
  const expression = new RegExp(`^([\\t ]*${property}:[\\t ]*)"(?:[^"\\\\]|\\\\.)*"(?=[\\t ]*,)`, "gm");
  const matches = [...source.matchAll(expression)];
  if (matches.length !== 1) throw new Error(`${file} must contain exactly one quoted ${property} property.`);
  return source.replace(expression, (_match, prefix) => `${prefix}${JSON.stringify(value)}`);
}

function replaceTomlProjectId(source, id) {
  const expression = /^project_id\s*=\s*"[^"]+"\s*$/gm;
  const matches = [...source.matchAll(expression)];
  if (matches.length !== 1) throw new Error("supabase/config.toml must contain exactly one project_id.");
  return source.replace(expression, `project_id = ${JSON.stringify(id)}`);
}

async function stageFile(root, path, content) {
  const target = join(root, path);
  const info = await readBoundedRegularFileDetails(target,{ minBytes: 1,maxBytes: MAX_TEMPLATE_INPUT_BYTES });
  const temporary = `${target}.template-init-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, content, { flag: "wx", mode: info.mode });
  return { path: target, temporary, original: info.bytes, mode: info.mode };
}

async function commitFiles(staged) {
  const replaced = [];
  try {
    for (const item of staged) {
      await rename(item.temporary, item.path);
      replaced.push(item);
    }
  } catch (error) {
    for (const item of replaced.reverse()) await writeFile(item.path, item.original, { mode: item.mode });
    throw error;
  } finally {
    await Promise.all(staged.map(item => rm(item.temporary, { force: true })));
  }
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(error.message); console.error(usage); process.exitCode = 2; return; }
  if (options.help) { console.log(usage); return; }
  if (!options.name || options.name !== options.name.trim() || options.name.length > 80 || /[\u0000-\u001f\u007f]/u.test(options.name)) {
    console.error("Provide --name as a trimmed, non-empty display name of at most 80 characters.");
    process.exitCode = 2;
    return;
  }
  const slug = options.slug ?? slugFromName(options.name);
  if (slug.length > 63 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    console.error("The project slug must be 1–63 lowercase letters or digits separated by single hyphens.");
    process.exitCode = 2;
    return;
  }

  const root = process.cwd();
  let packageJson, packageLock;
  try {
    [packageJson, packageLock] = await Promise.all([
      readText(join(root, "package.json")).then(JSON.parse),
      readText(join(root, "package-lock.json")).then(JSON.parse),
    ]);
  } catch {
    console.error("Run this command from the root of a template checkout with package.json and package-lock.json.");
    process.exitCode = 2;
    return;
  }
  if (!packageLock.packages?.[""] || packageJson.name !== packageLock.name || packageJson.name !== packageLock.packages[""].name) {
    console.error("package.json and package-lock.json names do not match; repair the lockfile before initializing the template.");
    process.exitCode = 2;
    return;
  }

  const packageNext = { ...packageJson, name: slug };
  const lockPackages = { ...packageLock.packages, "": { ...packageLock.packages[""], name: slug } };
  const lockNext = { ...packageLock, name: slug, packages: lockPackages };
  const [appConfigSource, supabaseSource, readmeSource] = await Promise.all([
    readText(join(root, "app.config.ts")),
    readText(join(root, "supabase/config.toml")),
    readText(join(root, "README.md")),
  ]);
  if (!readmeSource.startsWith("# ")) throw new Error("README.md must begin with a level-one title.");
  const appConfigNext = replaceTypeScriptString(
    replaceTypeScriptString(appConfigSource, "id", slug, "app.config.ts"),
    "name", options.name, "app.config.ts",
  );
  const readmeNext = readmeSource.replace(/^# [^\r\n]*/u, `# ${options.name}`);
  const changes = [
    ["package.json", `${JSON.stringify(packageNext, null, 2)}\n`],
    ["package-lock.json", `${JSON.stringify(lockNext, null, 2)}\n`],
    ["app.config.ts", appConfigNext],
    ["supabase/config.toml", replaceTomlProjectId(supabaseSource, slug)],
    ["README.md", readmeNext],
  ];
  const changed = [];
  for (const [path, content] of changes) {
    if (content !== await readText(join(root, path))) changed.push([path, content]);
  }
  if (!changed.length) {
    console.log(`Project identity is already initialized as ${JSON.stringify(options.name)} (${slug}).`);
    return;
  }
  console.log(`Project name: ${JSON.stringify(options.name)}\nProject slug: ${slug}\nFiles: ${changed.map(([path]) => path).join(", ")}`);
  if (!options.apply) {
    console.log("Preview only; rerun with --apply to write these changes.");
    return;
  }
  const staged = [];
  try {
    for (const [path, content] of changed) staged.push(await stageFile(root, path, content));
    await commitFiles(staged);
  } catch (error) {
    await Promise.all(staged.map(item => rm(item.temporary, { force: true })));
    throw error;
  }
  console.log("Template identity initialized. Review the changes, then run npm ci.");
}

main().catch(error => {
  console.error(`Template initialization failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
