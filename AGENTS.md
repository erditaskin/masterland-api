# Masterland API

Read `README.md` and `docs/contracts.md` before changing behavior. This API extends the existing Masterland mobile contracts; do not redesign gameplay or introduce a second wallet authority.

- Node 24, pnpm, strict TypeScript ESM, Fastify 5, Zod, Drizzle and PostgreSQL. No MongoDB, Redis or queue service.
- Validate every external boundary and declare route response schemas. Use opaque random sessions, SHA-256 hashes at rest, and SecureStore on mobile.
- All functions are arrows; use async/await with handled failures. No `any`, unsafe casts or TypeScript suppressions.
- The authenticated owner comes from the server session, never a submitted user ID. Serialize owner mutations in PostgreSQL transactions.
- Offline progress remains client-owned. Server authority covers identity, cloud revisions, verified reward receipts and deletion. Live purchases remain disabled.
- Test databases must start with `masterland_test`; migrations may only target `masterland_*`. Do not reset a database as part of deployment.
- Schema changes use `pnpm db:generate`; do not hand-edit generated migrations.
- Soruders is read-only reference. Never edit its services, data, DNS or secrets.
- No secret values in logs, source, bundles, release artifacts or command arguments. OAuth/callback query strings are not logged.
- Keep deployment versions and rollback evidence. Never claim device or provider acceptance based only on unit tests.
