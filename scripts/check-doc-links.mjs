import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const documents = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "THIRD_PARTY_NOTICES.md", "IMPLEMENTATION.md",
  ...(await readdir(resolve(root, "docs"))).filter(name => name.endsWith(".md")).map(name => `docs/${name}`)];

function withoutFences(markdown) {
  let fence;
  return markdown.split("\n").map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker && (!fence || (marker[1][0] === fence[0] && marker[1].length >= fence.length))) {
      fence = fence ? undefined : marker[1];
      return " ".repeat(line.length);
    }
    return fence ? " ".repeat(line.length) : line;
  }).join("\n");
}

function headingAnchors(markdown) {
  const anchors = new Set();
  const repeats = new Map();
  for (const match of markdown.matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const plain = match[1].replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "").replace(/`/g, "").toLowerCase();
    const base = plain.replace(/[^\p{L}\p{N}_\- ]/gu, "").replace(/ /g, "-");
    const count = repeats.get(base) ?? 0;
    repeats.set(base, count + 1);
    anchors.add(count ? `${base}-${count}` : base);
  }
  for (const match of markdown.matchAll(/<a\b[^>]*\b(?:id|name)=["']([^"']+)["'][^>]*>/g)) anchors.add(match[1]);
  return anchors;
}

const sources = new Map();
for (const name of documents) sources.set(resolve(root, name), withoutFences(await readFile(resolve(root, name), "utf8")));
const errors = [];
let checked = 0;
for (const [source, markdown] of sources) {
  const links = [
    ...markdown.matchAll(/!?\[[^\]\n]+\]\((<[^>\n]+>|[^\s)\n]+)(?:\s+[^)]*)?\)/g),
    ...markdown.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]+>|[^\s\n]+)/gm),
  ];
  for (const match of links) {
    const destination = match[1].replace(/^<|>$/g, "");
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(destination)) continue;
    const line = markdown.slice(0, match.index).split("\n").length;
    const location = `${relative(root, source)}:${line}`;
    let path, fragment;
    try {
      const [rawPath, rawFragment] = destination.split("#", 2);
      path = decodeURIComponent(rawPath.split("?", 1)[0]);
      fragment = rawFragment === undefined ? undefined : decodeURIComponent(rawFragment);
    } catch {
      errors.push(`${location}: malformed link ${destination}`);
      continue;
    }
    const target = path ? resolve(dirname(source), path) : source;
    const fromRoot = relative(root, target);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      errors.push(`${location}: link leaves repository: ${destination}`);
      continue;
    }
    const details = await stat(target).catch(() => null);
    if (!details) {
      errors.push(`${location}: missing target: ${destination}`);
      continue;
    }
    if (fragment && extname(target) === ".md") {
      const targetMarkdown = sources.get(target) ?? withoutFences(await readFile(target, "utf8"));
      if (!headingAnchors(targetMarkdown).has(fragment)) errors.push(`${location}: missing anchor: ${destination}`);
    }
    checked++;
  }
}
if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else console.log(`Documentation links passed: ${checked} local targets and anchors across ${documents.length} guides.`);
