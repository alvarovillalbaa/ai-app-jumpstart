# Dependency security gate

`npm run check:dependencies` runs `npm audit --audit-level=high`. The gate permits moderate and low advisories under that threshold and fails on unexpected high or critical advisories.

One exact exception is tracked for `brace-expansion@5.0.9` bundled inside the dev-only `aws-cdk-lib@2.271.0` dependency. The current audit identifies three advisories for that bundled copy: [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr), [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7) and [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p). The gate accepts them only at the exact lockfile path, package versions and advisory set. AWS CDK documents that consumer overrides cannot replace dependencies bundled inside `aws-cdk-lib`; the fix must arrive in an upstream package bundle ([AWS CDK issue](https://github.com/aws/aws-cdk/issues/38496)).

Remove the exception when the selected AWS CDK release bundles a `brace-expansion` version outside the affected advisory ranges. The gate will fail automatically if the CDK version, bundled path, brace-expansion version, audit range or advisory set changes.
