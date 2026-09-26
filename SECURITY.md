# Security policy

This template is pre-release. The latest `main` revision is the only branch considered for security fixes; no release series has a support commitment yet. Check [delivery status](docs/DELIVERY.md) before using it for production data or model spending.

Report a suspected vulnerability privately through the repository's [GitHub security advisory form](https://github.com/alvarovillalbaa/ai-app-jumpstart/security/advisories/new) if private reporting is available. If the form is unavailable, contact a repository maintainer through a private channel before sharing details. A public issue may request a private contact method, but must not include exploit steps, credentials, private data or unpatched source locations.

Include the affected commit or release, impact, safe reproduction steps and relevant configuration with secrets removed. Do not test against another person's deployment or copy real account data into a report. Maintainers will confirm the report, reproduce it in an isolated environment, prepare a fix and coordinate disclosure after a patched revision is available. The maintainers must verify that a private reporting channel is enabled before declaring a public release ready.

For dependency reports, name the package and version from `package-lock.json`. For application issues, distinguish the Next app, Eve service, data provider and deployment edge; each has a separate trust boundary. Keep production tokens, provider keys, model traces and backup contents out of issues and CI artifacts.
