# Contributing

Use Node 24.x and start from a fresh branch. Run `npm ci`, copy `.env.example` to `.env.local`, and use disposable credentials and databases. Never commit `.env.local`, `.data`, `.eve`, `.output`, test artifacts or production traces. See [README](README.md) for setup and [testing](docs/testing.md) for the provider and browser harnesses.

Before a pull request, run `npm run check`, `npm run test:ai` and the narrow integration suite for the area changed. A Next or Eve runtime change also needs `npm run build:local`; a Docker change needs `npm run test:container` and `npm run test:chat:container`. Run the PostgreSQL/Supabase/Convex contracts when changing shared data behavior. These checks use deterministic fixtures or disposable services and must not call a paid model by default.

Keep owner authorization, input validation and data shape in shared services. Add provider-specific code only at the adapter boundary, then update the common contracts and documentation. For SQL changes, add a new ordered file to `migrations/`, preview it with `npm run db:migrate -- --dry-run` against a disposable database, and test applying it twice. Never edit an applied migration or run a pull request's SQL against production.

Explain the behavior before and after the change, the deployment modes it affects, validation run and remaining limits. Preserve the original license and notices when modifying copied AI Elements or shadcn/ui components; see [third-party notices](THIRD_PARTY_NOTICES.md). Send vulnerability reports through the private process in [SECURITY.md](SECURITY.md), not a public issue or pull request.
