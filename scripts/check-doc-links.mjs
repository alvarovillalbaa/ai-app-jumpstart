import { readdir, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readBoundedRegularFile } from "../lib/security/read-bounded-file.mjs";

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
    const plain = stripHeadingMarkup(match[1]).toLowerCase();
    const base = [...plain].filter(character => /[\p{L}\p{N}_ \-]/u.test(character)).join("").replace(/ /g, "-");
    const count = repeats.get(base) ?? 0;
    repeats.set(base, count + 1);
    anchors.add(count ? `${base}-${count}` : base);
  }
  for (const match of markdown.matchAll(/<a\b[^>]*\b(?:id|name)=["']([^"']+)["'][^>]*>/g)) anchors.add(match[1]);
  return anchors;
}

function stripHeadingMarkup(source) {
  let plain = "";
  for (let index = 0; index < source.length;) {
    const image = source[index] === "!" && source[index + 1] === "[";
    const labelStart = image ? index + 1 : index;
    if (source[labelStart] === "[") {
      const labelEnd = source.indexOf("]", labelStart + 1);
      if (labelEnd > labelStart + 1 && source[labelEnd + 1] === "(") {
        const destinationEnd = source.indexOf(")", labelEnd + 2);
        if (destinationEnd >= 0) {
          plain += source.slice(labelStart + 1, labelEnd);
          index = destinationEnd + 1;
          continue;
        }
      }
    }
    if (source[index] === "<") {
      const tagEnd = source.indexOf(">", index + 1);
      if (tagEnd > index + 1) {
        index = tagEnd + 1;
        continue;
      }
    }
    if (source[index] !== "`") plain += source[index];
    index += 1;
  }
  return plain;
}

const sources = new Map();
async function readMarkdown(path) {
  return (await readBoundedRegularFile(path,{ minBytes: 0,maxBytes: 16 * 1024 * 1024 })).toString("utf8");
}
for (const name of documents) sources.set(resolve(root, name), withoutFences(await readMarkdown(resolve(root,name))));
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
    if (fragment && extname(target) === ".md") {
      let targetMarkdown = sources.get(target);
      if (targetMarkdown === undefined) {
        try { targetMarkdown = withoutFences(await readMarkdown(target)); }
        catch (error) {
          errors.push(`${location}: ${error?.code === "ENOENT" ? "missing target" : "unsafe or unreadable target"}: ${destination}`);
          continue;
        }
      }
      if (!headingAnchors(targetMarkdown).has(fragment)) errors.push(`${location}: missing anchor: ${destination}`);
    } else {
      const details = await stat(target).catch(() => null);
      if (!details) {
        errors.push(`${location}: missing target: ${destination}`);
        continue;
      }
    }
    checked++;
  }
}
if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else console.log(`Documentation links passed: ${checked} local targets and anchors across ${documents.length} guides.`);
