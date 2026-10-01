import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

type Advisory = { url?: string; severity?: string };
type Vulnerability = { severity?: string; range?: string; via?: Array<string | Advisory>; nodes?: string[] };
type AuditReport = { error?: { code?: string; summary?: string }; vulnerabilities?: Record<string, Vulnerability>; metadata?: { vulnerabilities?: Record<string, number> } };
type PackageLock = { packages?: Record<string, { version?: string; dev?: boolean; inBundle?: boolean; bundleDependencies?: string[] } | undefined> };

const EXPECTED_CDK_VERSION = "2.271.0";
const EXPECTED_BRACE_VERSION = "5.0.9";
const EXPECTED_BRACE_PATH = "node_modules/aws-cdk-lib/node_modules/brace-expansion";
const EXPECTED_ADVISORIES = [
  { url: "https://github.com/advisories/GHSA-q2hr-2g5m-vwhr", severity: "moderate" },
  { url: "https://github.com/advisories/GHSA-qhr7-859c-m2p7", severity: "high" },
  { url: "https://github.com/advisories/GHSA-6j4f-fj2g-mc7p", severity: "high" },
];

export function validateAudit(report: AuditReport, manifest: { devDependencies?: Record<string, string> }, lock: PackageLock): { acceptedBundledFinding: boolean } {
  if (report.error) throw new Error(`npm audit failed: ${report.error.summary ?? report.error.code ?? "unknown error"}`);
  if (!report.vulnerabilities) throw new Error("npm audit returned no vulnerability report");

  const highOrCritical = Object.entries(report.vulnerabilities).filter(([, issue]) => issue.severity === "high" || issue.severity === "critical");
  if (highOrCritical.length === 0) return { acceptedBundledFinding: false };
  if (highOrCritical.length !== 1 || highOrCritical[0]?.[0] !== "brace-expansion") {
    throw new Error(`Unexpected high or critical npm advisories: ${highOrCritical.map(([name]) => name).join(", ")}`);
  }

  const [name, issue] = highOrCritical[0];
  const expectedCdk = lock.packages?.["node_modules/aws-cdk-lib"];
  const bundledBrace = lock.packages?.[EXPECTED_BRACE_PATH];
  const expectedAdvisories = EXPECTED_ADVISORIES.map(({ url, severity }) => `${url}|${severity}`).sort();
  const actualAdvisories = (issue.via ?? [])
    .filter((entry): entry is Advisory => typeof entry !== "string")
    .map(({ url, severity }) => `${url}|${severity}`)
    .sort();
  const exactNode = issue.nodes?.length === 1 && issue.nodes[0] === EXPECTED_BRACE_PATH;
  const exactAdvisories = JSON.stringify(actualAdvisories) === JSON.stringify(expectedAdvisories);
  const exactBundle = name === "brace-expansion"
    && issue.severity === "high"
    && issue.range === "4.0.0 - 5.0.11"
    && exactNode
    && exactAdvisories
    && manifest.devDependencies?.["aws-cdk-lib"] === EXPECTED_CDK_VERSION
    && expectedCdk?.version === EXPECTED_CDK_VERSION
    && expectedCdk.dev === true
    && expectedCdk.bundleDependencies?.includes("minimatch") === true
    && bundledBrace?.version === EXPECTED_BRACE_VERSION
    && bundledBrace.dev === true
    && bundledBrace.inBundle === true;

  if (!exactBundle) throw new Error("High brace-expansion advisory does not match the tracked AWS CDK bundle exception");
  return { acceptedBundledFinding: true };
}

export function auditSummary(report: AuditReport): string {
  const counts = report.metadata?.vulnerabilities;
  if (!counts) return "npm audit completed";
  return `npm audit reported ${counts.total ?? 0} advisories (${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low)`;
}

export function runDependencyAudit(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { devDependencies?: Record<string, string> };
  const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8")) as PackageLock;
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["audit", "--json", "--audit-level=high"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  if (result.error) throw result.error;
  let report: AuditReport;
  try {
    report = JSON.parse(result.stdout) as AuditReport;
  } catch {
    throw new Error(`npm audit did not return JSON${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  }

  const validation = validateAudit(report, manifest, lock);
  if (result.status !== 0 && result.status !== 1) throw new Error(`npm audit exited with status ${result.status}: ${result.stderr.trim()}`);
  if (result.status === 1 && !validation.acceptedBundledFinding) throw new Error(`npm audit exited with status 1 without a tracked high advisory: ${result.stderr.trim()}`);

  console.log(auditSummary(report));
  if (validation.acceptedBundledFinding) {
    console.warn(`Accepted the tracked dev-only bundled ${EXPECTED_BRACE_PATH}@${EXPECTED_BRACE_VERSION} finding under aws-cdk-lib@${EXPECTED_CDK_VERSION}; see docs/dependency-security.md.`);
  } else {
    console.log("No high or critical npm advisories found.");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runDependencyAudit();
