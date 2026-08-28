# TagBridge

Industrial buyers search by symptom. A maintenance engineer with a line down types
*get tag data from a ControlLogix into SQL Server*, or *Modbus device won't talk to my
SCADA* — not a part number they do not have yet. Catalog search built for consumer
retail returns nothing for those queries, and the buyer leaves. TagBridge is a
storefront for industrial connectivity software built around that fact: hybrid
retrieval with a protocol and vendor synonym layer, a quote path because industrial
buying is quote-shaped rather than cart-shaped, and subscription-to-ERP sync that
survives the failure modes real integrations hit.

**Status: phases 0 and 1 of 5 complete.** The search evaluation — the number this
project exists to produce — lands in phase 2 and is not claimed here until it is
measured.

| | |
|---|---|
| Live URL | not yet deployed — see [Deploying](#deploying) |
| Search eval (precision@3, hybrid + rerank vs BM25) | phase 2, not yet measured |
| Products in catalog | 50 |
| Tests | 95 unit + integration, 19 end-to-end |
| Lighthouse (mobile, product page) | 99 / 100 / 100 / 100 |

### Lighthouse

Mobile preset, measured against the production build by `pnpm lighthouse`, which
fails if any page misses a threshold and runs as its own CI job. Each page is
warmed and then measured three times; the table reports the median of each metric.

| Page | Perf | A11y | Best Prac. | SEO | LCP | CLS | TBT |
|---|---|---|---|---|---|---|---|
| Home | 99 | 100 | 100 | 100 | 1889 ms | 0 | 106 ms |
| Catalog | 99 | 100 | 100 | 100 | 1799 ms | 0 | 112 ms |
| Product | 99 | 100 | 100 | 100 | 1868 ms | 0 | 98 ms |

TBT is the lab proxy for INP; Lighthouse cannot measure INP without field data.

## What is built

**Phase 0 — foundation.** Next.js 15 App Router on TypeScript strict, the full data
model in Drizzle with migrations, a 50-product catalog written for this project,
a 148-edge synonym graph, Auth.js v5 with role-based authorization, structured
logging, a health endpoint, and CI that gates on every check.

**Phase 1 — catalog and cart.** Faceted catalog by category, protocol, vendor and
licence type; product pages with variants and their full quantity ladders; a cart;
and two checkout paths — a purchase order path that creates a real order with no
payment taken, and a Stripe card path.

Phases 2–5 (the search pipeline, quotes and the agent, subscription sync, and the
agent-native UCP/MCP layer) are specified in [`SPEC.md`](SPEC.md) and not yet built.

### Pricing is computed in one place

`lib/commerce/pricing.ts` resolves every price from the variant's ladder in
`price_tiers`, on the server. The cart stores quantities and nothing else, so a
price cannot go stale between adding an item and checking out — change a ladder and
the open cart re-prices itself, which is covered by a test.

The request schemas are `.strict()` and carry no price field, and
`containsPriceField()` refuses anything price-shaped at the trust boundary. Today
that guards the cart; from phase 3 it is what stops a model setting a price.

## Architecture

```
app/
  (shop)                        catalog · product · cart · checkout · confirmation
  (account) (admin)             middleware gates both; pages re-check the session
  api/health                    DB reachability, provider configuration
  api/auth/[...nextauth]        Auth.js route handler
lib/
  db/       schema · migrations · catalog · synonyms · seed · PGlite harness
  auth/     edge-safe config · providers + adapter · role helpers · guards
  telemetry logger with declared PII redaction
  commerce/ pricing · catalog queries · cart · cart session · orders · payments
tests/
  unit/         catalog integrity, price ladders, pricing engine, synonyms, roles, env
  integration/  migrations, seed idempotency, FTS vector, constraints, catalog,
                cart re-pricing, PO checkout, order numbering, audit rows
  e2e/          home, health, auth and role gating, catalog facets, price ladder,
                cart, PO checkout, confirmation
```

### The database is real in every environment

The app talks to Postgres. With `DATABASE_URL` set that is a hosted Postgres and it is
durable. Without one, the app restores a build-time snapshot into
[PGlite](https://pglite.dev) — Postgres compiled to WebAssembly, running in-process,
carrying the *same* migrations and the *same* pgvector extension.

This is not a mock. `pnpm test` exercises real `tsvector` generation, real HNSW index
creation, real unique-constraint violations.

The snapshot is why this deploys with no configuration at all. Booting PGlite, applying
migrations and seeding takes about ten seconds; restoring a snapshot of the finished
result takes about one, so a cold start pays a second rather than ten. The cost is that
the fallback database lives in memory: browsing, pricing and search are identical to
production, but a cart or an order lasts only as long as the instance that created it.
Set `DATABASE_URL` and that limitation disappears.

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
pnpm db:setup     # builds the seeded database snapshot
pnpm dev          # http://localhost:3000
```

No database, no mail server and no OAuth client are required. `pnpm db:setup` prints
what it seeded; the home page shows the same count.

**Signing in.** With no mail server or Google client configured, the sign-in page offers
the three seeded demo accounts (`buyer@`, `sales@`, `admin@example.com`) directly — a
deployment with no way to sign in is useless, and these accounts hold no real data. The
provider accepts no other address, withdraws itself as soon as a real provider is
configured, and can be turned off outright with `AUTH_DEV_LOGIN=false`. Configure
`EMAIL_SERVER`/`EMAIL_FROM` or `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET` and the real
providers appear in its place.

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

The repository deploys with no environment variables set: `vercel.json` runs
`pnpm db:setup` before the build, which generates a session secret and the database
snapshot the running app restores.

For a durable deployment, set two variables and redeploy:

- `DATABASE_URL` — a Postgres connection string. Migrations and seeding run against it
  at build time, and the in-memory fallback is never used.
- `AUTH_SECRET` — `openssl rand -base64 32`. Without it a fresh secret is generated on
  every build, so sessions do not survive a redeploy.

Configuring `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`, or `EMAIL_SERVER` / `EMAIL_FROM`
alongside `DATABASE_URL`, replaces the demo accounts with real sign-in automatically.

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

**A random order number is not a unique order number.** `TB-YYYYMM-` plus six random
hex characters looks safe and is not: at a few thousand orders a collision is more
likely than not, and `orders.number` is unique, so the failure would surface as a
rejected order at checkout. The test that generated 5,000 numbers caught it on the
first run. Order numbers now come from a Postgres sequence — unique by construction
rather than by luck.

**The product page's meta description never reached `<head>`.** Lighthouse scored the
page 90 on SEO while `curl` clearly showed the tag. Next streams metadata into the
body for a dynamically rendered page and hydration relocates it, so anything that does
not run JavaScript — crawlers included — never sees it. Both public pages are now
prerendered and revalidated, which put the description in `<head>` and took SEO to 100.

**Two Next build workers raced for one PGlite directory.** After the home page became
prerendered, a build failed on a random product page, then passed on a retry. PGlite
holds an exclusive lock on its data directory and Next spawns several workers for
static generation. The build now uses a single worker when — and only when — there is
no `DATABASE_URL`, because real Postgres has no such problem.

**A single Lighthouse run is not a measurement.** The gate passed locally and failed
in CI on total blocking time — 356 ms against a 200 ms threshold, on the home page,
while a heavier page in the same run read 73 ms. The page was not the problem: it was
simply the first one measured after the server booted, on a shared two-core runner.
The runner now warms each page and takes the median of three runs, the way Lighthouse
CI aggregates. The thresholds did not move.

**A generated file that generated nothing.** The session secret module is written by a
script and gitignored, so CI — which typechecks immediately after installing — found no
module and failed with `TS2307`. It had only ever passed locally because an earlier
build had left the file behind. Generating it on `postinstall` puts it in place
everywhere before anything reads it. The first version of that script also blanked the
constant whenever `AUTH_SECRET` happened to be set in the environment, which made the
result depend on which command ran last: an end-to-end run that set it in a subprocess
left the next plain build with no secret at all.

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
