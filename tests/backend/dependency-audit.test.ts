import { describe, expect, it } from "vitest";
import { validateAudit } from "../../scripts/check-dependencies.ts";

const advisories = [
  { url: "https://github.com/advisories/GHSA-q2hr-2g5m-vwhr", severity: "moderate" },
  { url: "https://github.com/advisories/GHSA-qhr7-859c-m2p7", severity: "high" },
  { url: "https://github.com/advisories/GHSA-6j4f-fj2g-mc7p", severity: "high" },
];

function report(vulnerabilities: Record<string, unknown>) {
  return { vulnerabilities } as Parameters<typeof validateAudit>[0];
}

function exceptionFixture() {
  return {
    audit: report({
      "brace-expansion": {
        severity: "high",
        range: "4.0.0 - 5.0.11",
        via: advisories,
        nodes: ["node_modules/aws-cdk-lib/node_modules/brace-expansion"],
      },
    }),
    manifest: { devDependencies: { "aws-cdk-lib": "2.271.0" } },
    lock: {
      packages: {
        "node_modules/aws-cdk-lib": { version: "2.271.0", dev: true, bundleDependencies: ["minimatch"] },
        "node_modules/aws-cdk-lib/node_modules/brace-expansion": { version: "5.0.9", dev: true, inBundle: true },
      },
    },
  };
}

describe("dependency audit gate", () => {
  it("accepts only the exact tracked AWS CDK bundled advisory", () => {
    const fixture = exceptionFixture();
    expect(validateAudit(fixture.audit, fixture.manifest, fixture.lock)).toEqual({ acceptedBundledFinding: true });
  });

  it("allows moderate findings at the configured high threshold", () => {
    expect(validateAudit(report({ "some-package": { severity: "moderate" } }), {}, {})).toEqual({ acceptedBundledFinding: false });
  });

  it("rejects another vulnerable path or bundled version", () => {
    const fixture = exceptionFixture();
    fixture.lock.packages["node_modules/aws-cdk-lib/node_modules/brace-expansion"].version = "5.0.10";
    expect(() => validateAudit(fixture.audit, fixture.manifest, fixture.lock)).toThrow("does not match the tracked AWS CDK bundle exception");
  });

  it("rejects new high advisories even when they affect the same bundled package", () => {
    const fixture = exceptionFixture();
    (fixture.audit.vulnerabilities!["brace-expansion"] as { via: unknown[] }).via.push({ url: "https://github.com/advisories/GHSA-new-example", severity: "high" });
    expect(() => validateAudit(fixture.audit, fixture.manifest, fixture.lock)).toThrow("does not match the tracked AWS CDK bundle exception");
  });

  it("rejects every other high or critical package finding", () => {
    const fixture = exceptionFixture();
    fixture.audit.vulnerabilities!.undici = { severity: "high", via: [], nodes: ["node_modules/undici"] };
    expect(() => validateAudit(fixture.audit, fixture.manifest, fixture.lock)).toThrow("Unexpected high or critical npm advisories");
  });
});
