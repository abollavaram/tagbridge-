# TagBridge

Industrial buyers search by symptom. A maintenance engineer with a line down types
*get tag data from a ControlLogix into SQL Server*, or *Modbus device won't talk to my
SCADA* — not a part number they do not have yet. Catalog search built for consumer
retail returns nothing for those queries, and the buyer leaves. TagBridge is a
storefront for industrial connectivity software built around that fact: hybrid
retrieval with a protocol and vendor synonym layer, a quote path because industrial
buying is quote-shaped rather than cart-shaped, and subscription-to-ERP sync that
survives the failure modes real integrations hit.

**Status: phase 0 of 5 complete.** The search evaluation — the number this project
exists to produce — lands in phase 2 and is not claimed here until it is measured.

| | |
|---|---|
| Live URL | not yet deployed — see [Deploying](#deploying) |
| Search eval (precision@3, hybrid + rerank vs BM25) | phase 2, not yet measured |
| Products in catalog | 50 |
| Tests | 44 unit + integration, 9 end-to-end |

## What is built

**Phase 0 — foundation.** Next.js 15 App Router on TypeScript strict, the full data
model in Drizzle with migrations, a 50-product catalog written for this project,
a 148-edge synonym graph, Auth.js v5 with role-based authorization, structured
logging, a health endpoint, and CI that gates on every check.

Phases 1–5 (catalog and cart, the search pipeline, quotes and the agent, subscription
sync, and the agent-native UCP/MCP layer) are specified in [`SPEC.md`](SPEC.md) and
not yet built.

## Architecture

```
app/
  (shop) (account) (admin)      route groups; middleware gates the last two
  api/health                    DB reachability, provider configuration
  api/auth/[...nextauth]        Auth.js route handler
lib/
  db/       schema · migrations · catalog · synonyms · seed · PGlite harness
  auth/     edge-safe config · providers + adapter · role helpers · guards
  telemetry logger with declared PII redaction
tests/
  unit/         catalog integrity, price ladders, synonym graph, roles, env
  integration/  migrations, seed idempotency, FTS vector, constraints
  e2e/          home, health, auth redirects, role gating, sign-out
```

### The database is real in every environment

The app talks to Postgres. With `DATABASE_URL` set that is Neon; without it the app
falls back to [PGlite](https://pglite.dev) — Postgres compiled to WebAssembly, running
in-process, carrying the *same* migrations and the *same* pgvector extension.

This is not a mock. `pnpm test` exercises real `tsvector` generation, real HNSW index
creation, real unique-constraint violations. It also means a clean clone runs the full
suite, and the end-to-end run boots a seeded storefront, without provisioning anything.

### Search vector

The BM25 leg of the phase-2 retriever reads a generated `tsvector` column with name and
SKU at weight A, protocols and vendor compatibility at B, and prose at C — so an exact
part number outranks a description that merely mentions one. The expression lives in an
`IMMUTABLE` SQL function declared in migration `0000`, because `array_to_string` is not
immutable and Postgres refuses it in an index expression otherwise.

### Authorization

Roles are `guest`, `buyer`, `sales`, `admin`. Middleware keeps unauthenticated traffic
off `/account`, `/quotes`, `/orders` and `/admin`, but it is the first gate and never
the decision: every protected page re-reads the session server-side through
`lib/auth/guards.ts`. Row-level ownership (`canReadOwnedResource`) is unit tested
against the case that matters — one buyer asking for another buyer's resource.

Sessions are JWT-backed with `httpOnly`, `sameSite=lax`, `secure` in production, and a
30-day rolling window. The Drizzle adapter persists users, accounts and magic-link
tokens whenever a real database is configured.

## Running it

From a clean clone, with Node 22 and pnpm 10:

```bash
pnpm install
cp .env.example .env
pnpm db:setup     # creates and seeds the local PGlite database
pnpm dev          # http://localhost:3000
```

No database, no mail server and no OAuth client are required. `pnpm db:setup` prints
what it seeded; the home page shows the same count.

**Signing in.** With no mail server or Google client configured, the sign-in page offers
the three seeded demo accounts (`buyer@`, `sales@`, `admin@example.com`) directly. That
provider accepts no other address and refuses to load at all when `NODE_ENV` is
production, unless `ALLOW_DEV_LOGIN_IN_PROD` is explicitly set for the public demo.
Configure `EMAIL_SERVER`/`EMAIL_FROM` or `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET` and the
real providers appear.

### Verifying

```bash
pnpm verify   # typecheck → lint → test → test:e2e → audit --prod
```

Individually: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:e2e`,
`pnpm audit --prod`. CI runs all of them on every pull request and gates the build on
each one.

`pnpm eval:search` joins `pnpm verify` in phase 2, when there is a search pipeline to
evaluate and a golden query set to evaluate it against.

## Deploying

Not yet deployed. To deploy:

1. Create a Neon Postgres database and enable `pgvector`.
2. Import this repository into Vercel.
3. Set `DATABASE_URL` and `AUTH_SECRET` (`openssl rand -base64 32`). Add
   `AUTH_DEV_LOGIN=true` and `ALLOW_DEV_LOGIN_IN_PROD=true` if the demo accounts should
   work on the public URL; otherwise configure a real provider.
4. Deploy. `vercel.json` runs `pnpm db:setup` before `pnpm build`, which applies
   migrations and seeds the catalog idempotently.

## What broke and how it was fixed

**The full-text index would not create.** The obvious index expression —
`to_tsvector('english', name || ' ' || array_to_string(protocols, ' ') || …)` — is
rejected with `42P17`: index expressions must be `IMMUTABLE`, and `array_to_string` is
marked stable. Wrapping the whole expression in a function declared `IMMUTABLE` and
indexing a generated column on it fixes the cause rather than dropping the array fields
from the index, which would have quietly cost recall on vendor queries in phase 2.

**Every raw-SQL count returned zero.** `db.execute` returns the row array under
postgres-js and a `{ rows }` result object under PGlite. The app read zero rows in the
PGlite path without erroring — the worst kind of failure. Everything reading raw SQL now
goes through `toRows()` in `lib/db/rows.ts`, and the integration tests would now catch a
regression.

**PGlite's pgvector extension disappeared in the production build.** The extension ships
as a tarball asset loaded at runtime; the bundler rewrote its path to a `/_next/static`
URL that does not resolve. It only surfaced as a log line, because the test database had
already been created with the extension present. Adding the package to
`serverExternalPackages` fixed it; deleting `.pglite` and re-running the e2e suite from
an empty database confirmed it.

**Five advisories in the production dependency tree.** `postcss` (three, up to high) came
in transitively through Next, and `nodemailer` (high) was pinned back to v8 to satisfy
an Auth.js peer range that predates the patched release. Both are resolved with pnpm
overrides to the patched versions; `pnpm audit --prod` is clean and CI fails on high.

## Ground rules this project holds itself to

- Every product name, description and part number here was written for this project. The
  protocol and device vocabulary (OPC UA, Modbus TCP, EtherNet/IP, ControlLogix,
  Sparkplug B, BACnet/IP, DNP3) is public technical fact and is used deliberately — it is
  what makes the search evaluation meaningful. No company's copy, images or page
  structure was used.
- No feature without a test.
- No claimed metric that was not measured. Numbers that do not exist yet are marked as
  such rather than estimated.
- The model never sets a price. Enforced from phase 3, in the schema from phase 0:
  `quote_line_items.unit_price_cents` is only ever written from `price_tiers`.
