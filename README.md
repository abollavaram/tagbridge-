# TagBridge

Industrial buyers search by symptom. A maintenance engineer with a line down types
*get tag data from a ControlLogix into SQL Server*, or *Modbus device won't talk to my
SCADA* — not a part number they do not have yet. Catalog search built for consumer
retail returns nothing for those queries, and the buyer leaves. TagBridge is a
storefront for industrial connectivity software built around that fact: hybrid
retrieval with a protocol and vendor synonym layer, a quote path because industrial
buying is quote-shaped rather than cart-shaped, and subscription-to-ERP sync that
survives the failure modes real integrations hit.

**Status: all 5 phases complete, and an external review's findings closed.** Two
acceptance criteria are not met and are reported as such below — the search lift
threshold, and the demo video.

| | |
|---|---|
| Live URL | see [Deploying](#deploying) |
| Search precision@3, hybrid + rerank | **0.89** |
| …against a default full-text baseline | **0.52** |
| Agent guardrail hold rate, 10 adversarial scenarios | **100%** |
| Products in catalog | 50 |
| Tests | 613 unit + integration, 101 end-to-end |
| Lighthouse (mobile, product page) | 99 / 100 / 100 / 100 |

## Search evaluation

100 labelled queries in four buckets of 25, run through each stage of the pipeline in
isolation. Reproduce with `pnpm eval:search`.

| | precision@3 | recall@5 | MRR |
|---|---|---|---|
| BM25 naive | 0.52 | 0.60 | 0.62 |
| BM25 only | 0.81 | 0.83 | 0.82 |
| BM25 + synonyms | 0.83 | 0.89 | 0.81 |
| Vector only | 0.83 | 0.86 | 0.90 |
| Hybrid (RRF) | 0.87 | 0.91 | 0.90 |
| **Hybrid + rerank** | **0.89** | **0.92** | **0.92** |

precision@3 by bucket:

| | part-number | problem-shaped | synonym | compatibility |
|---|---|---|---|---|
| BM25 naive | 0.00 | 0.76 | 0.59 | 0.73 |
| BM25 only | 0.88 | 0.74 | 0.74 | 0.88 |
| Vector only | 0.92 | 0.79 | 0.75 | 0.87 |
| **Hybrid + rerank** | **1.00** | **0.78** | **0.85** | **0.92** |

p95 latency 13 ms against a 400 ms budget.

**Read this table carefully, because two rows of it are the honest part.**

*Two baselines, not one.* "BM25 naive" is a default full-text setup: unweighted
`to_tsvector` over name and description, no synonyms, no part-number handling. It scores
**0.00** on part-number lookups, because a product's SKU appears in neither its name nor
its description — a stock catalogue literally cannot find its own part numbers. That is
the incumbent an industrial buyer is failing to search. "BM25 only" is the same weighted
`tsvector` and schema this project uses, minus the synonym and hybrid layers, and it is a
much harder thing to beat.

*The spec asked for a 0.15 lift over BM25 and this does not reach it.* Against the naive
baseline the lift is 0.37; against the weighted baseline it is 0.08. I report the
conservative number and treat the criterion as unmet rather than picking the baseline
that flatters it. Most of the gain over a default setup comes from schema and index
design — weighting name and SKU above prose, indexing protocols, vendors and spec values
— not from the hybrid retrieval on top of it. That is a real finding and it is the
opposite of what the pitch would prefer to say.

*precision@3 is normalised.* A part-number query has one correct answer, so plain
precision@3 caps at 0.33 for it however perfect the ranking. The figure here is
`hits / min(3, relevant)`.

*Weights were tuned against this same set.* There is no held-out split, so the absolute
number is optimistic. A held-out set is the obvious next step.

*Embeddings are local.* No embedding API key was available, so `HashingEmbedder` projects
text into 1536 dimensions using character n-grams and synonym canonicalisation. It handles
misspellings and vendor aliases; it does not handle genuine paraphrase the way a hosted
model would. `Embedder` is the seam — swapping in Voyage or OpenAI is a one-file change,
and the problem-shaped bucket (0.78, the weakest) is where it would show.

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

**Phase 2 — search.** Query normalisation that preserves part numbers, bidirectional
synonym expansion over a 148-edge graph, BM25 over a weighted `tsvector` and dense
retrieval over pgvector in parallel, reciprocal rank fusion at k=60, a deterministic
reranker that explains every result, and an intent classifier routing browse,
specific-product and compatibility questions.

**Phase 3 — quotes and the agent.** A deterministic compatibility resolver, a quote
state machine whose illegal transitions throw, and a tool-calling agent behind every
guardrail in §7 of the spec: the model never sets a price, both tool schemas are
validated, authorization is re-derived inside each tool from the session, catalog text
is delimited and cannot expand the tool allowlist, and every agent-drafted quote goes
to a human at `/approvals` regardless of value. `pnpm eval:agent` scores 30 scenarios,
ten of them adversarial.

**Phase 4 — subscription sync.** A webhook that is a trigger and never truth: every
event causes a re-read of the subscription from the provider, ordering resolves on the
provider's event timestamp rather than arrival order, and idempotency is a unique
constraint rather than a check-then-insert. Failures back off, dead-letter after five
attempts, and replay. A nightly reconciliation compares the provider against the ERP
records directly, because the failures worth catching are all missing signals.
`/admin/sync` shows throughput, queue depth and drift, with a "break sync" button that
creates real drift the way a dropped webhook would.

**Phase 5 — agent-native layer.** A UCP profile at `/.well-known/ucp`, an MCP server
sharing the agent's own tool registry (HTTP at `/api/mcp`, stdio via `pnpm mcp`), and
ACP-shaped checkout sessions. Both protocol schemas are vendored at a pinned commit in
[`spec-snapshots/`](spec-snapshots/) and the profile is validated against them offline.
A recorded session is in [`docs/mcp-session.md`](docs/mcp-session.md), generated by
`pnpm mcp:transcript` rather than written by hand.

### Built against

| Protocol | Version | Snapshot |
|---|---|---|
| Universal Commerce Protocol | 2026-08-25 | `universal-commerce-protocol/ucp` @ `1d39948` |
| Agentic Commerce Protocol | 2026-04-17 | `agentic-commerce-protocol` @ `7fdd78d` |
| Model Context Protocol | 2025-06-18 | — |

### Every result explains itself

The spec calls for an LLM reranker. The seam is there (`Reranker`,
`llmRerankerAvailable()`), but the default is deterministic and feature-based: it needs no
key, runs in under a millisecond, and — the reason I would keep it either way — its
decisions are inspectable. A result carries the reasons it was promoted, so
`"allen-bradley" in the product name, for "controllogix"` is visible on the page. A bad
ranking is debuggable instead of a shrug.

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

## The shape of it

```
                     browser            Claude Desktop        any UCP agent
                        │                     │                     │
                        │ HTML / server       │ MCP over stdio      │ /.well-known/ucp
                        ▼ actions             ▼ or HTTP             ▼ then REST
        ┌───────────────────────────────────────────────────────────────────┐
        │  Next.js App Router · middleware issues a per-request CSP nonce   │
        └───────────────────────────────────────────────────────────────────┘
                        │                     │                     │
                        └──────────┬──────────┴──────────┬──────────┘
                                   ▼                     ▼
                        ┌──────────────────┐   ┌───────────────────┐
                        │  agent loop      │   │  UCP / ACP        │
                        │  8 turns, 60s    │   │  services         │
                        └──────────────────┘   └───────────────────┘
                                   │                     │
                                   └──────────┬──────────┘
                                              ▼
                        ┌───────────────────────────────────────┐
                        │  ONE tool registry — lib/agent/tools  │
                        │  schema in · schema out · authz here  │
                        └───────────────────────────────────────┘
                                              │
        ┌──────────────┬──────────────┬───────┴───────┬─────────────────┐
        ▼              ▼              ▼               ▼                 ▼
   search          compatibility   pricing        quotes            audit log
   BM25 + dense    rule engine     price_tiers    state machine     append only
   + RRF + rerank  deterministic   server only    illegal → throw
        │              │              │               │                 │
        └──────────────┴──────────────┴───────┬───────┴─────────────────┘
                                              ▼
                        ┌───────────────────────────────────────┐
                        │  Postgres — pgvector + GIN FTS        │
                        │  PGlite in-process, or DATABASE_URL   │
                        └───────────────────────────────────────┘
                                              ▲
                        ┌─────────────────────┴─────────────────┐
                        │  three crons, bearer-authenticated    │
                        │  reconcile · expire quotes · retries  │
                        └───────────────────────────────────────┘
```

The single tool registry is the load-bearing decision. The browser assistant, the MCP
server and the internal agent loop are three consumers of *one* set of tool definitions,
so there is one schema, one authorization check and one place the price rule lives. Two
registries would mean two of each, and the second would drift.

## Guardrails — what could go wrong, and what stops it

| Risk | What stops it | Where |
|---|---|---|
| The model sets a price | No input schema accepts one, and a price-shaped field anywhere in the payload is refused rather than stripped — including the agent protocols' own spellings (`unit_amount`, `presentment_amount`) | `lib/agent/guardrails.ts`, `lib/commerce/pricing.ts` |
| Catalogue text tells the model what to do | Retrieved text is delimited, the delimiters are neutralised inside it, and the tool allowlist is built from the registry before the model is asked anything — content cannot widen it | `wrapUntrusted`, `checkToolAllowed` |
| A caller acts as somebody else | No input schema has a field for an identity. Every tool re-derives authorization from the session, and the loop is not the only gate | every tool in `lib/agent/tools.ts` |
| A quote goes out without a human | Every agent-drafted quote enters `pending_approval` regardless of value — the agent is not the one deciding whether a human is needed | `stateAfterSubmit` |
| An order is read by a stranger | Order numbers come from a sequence and are not credentials. Reading needs an unguessable token, or the signed-in owner, or staff — and a miss is a 404, so ids are not enumerable | `getOrderForReader` |
| A runaway or expensive loop | Token, tool-call and turn budgets; an `AbortSignal` derived from the remaining wall-clock; per-IP rate limits; a circuit breaker with a real half-open probe that fails **closed to the deterministic path**, not to an error | `lib/agent/guardrails.ts`, `lib/agent/loop.ts` |
| PII in logs and prompts | Redacted on the way into the audit log; the model never receives the buyer's identity, because it does not need it to pick a product | `redactObject` |
| A payment recorded that did not happen | The amount Stripe reports is checked against the order's own subtotal before anything is marked paid, and a mismatch is deliberately retryable so it reaches the dead-letter queue where a person sees it | `markOrderPaid` |
| An audit log that records fiction | `sendQuoteEmail` reports `sent: false` when no transport is configured, and logs `quote.send.unavailable` rather than `quote.send` | `lib/agent/tools.ts` |

Ten adversarial scenarios exercise these on every change; the hold rate must be 100% and
`pnpm eval:agent` fails the build below that.

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

`pnpm eval:search` runs the golden set and prints the table above. It is **not** yet part
of `pnpm verify` or CI, because it currently exits non-zero on the 0.15-lift criterion
discussed above and that criterion needs a decision before it gates the build.

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

**Only some items reached the cart.** Reported from the deployed site, and the
explanation was in the architecture rather than the cart code. Without a shared
database each serverless instance restores the snapshot into its *own* memory, so a
cart row written while serving one request did not exist for the next request if it
landed elsewhere — items appeared to vanish at random. Cart contents now live in the
cookie: only variant ids and quantities, with every price still resolved server-side
from `price_tiers` on read, so the guarantee that a client cannot choose what something
costs is unchanged.

The reason it survived a full end-to-end suite is worth more than the fix: **every cart
test added exactly one product.** One item can never expose a bug that only appears
across two. There are now tests for two products and for three.

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

**The synonym layer was hiding inside the baseline.** The first eval run showed hybrid
beating "BM25 only" by 0.06 and I nearly reported that as a disappointing result. The
baseline was getting the synonym expansion too — so the row labelled "BM25 only" was
measuring most of the contribution and then being subtracted from it. Splitting the
baselines apart is why the table now has five rows instead of three.

**Improving the schema improved the baseline more than the system.** Indexing spec values
(`ssoSupport: 'SAML, OIDC'` was unfindable — only the keys were indexed) fixed a query
that had been returning nothing. It also raised the BM25 baseline's compatibility score
from 0.84 to 0.88, so the measured *lift* went down while the product got better. Worth
knowing before optimising for a delta.

**An external review found three critical security defects, all reproduced.** Worth
recording in full, because the pattern in two of them is the same and it is the one
worth learning.

*Any stranger could read any order.* The confirmation page loaded an order by number
with no session check and no ownership check — and order numbers come from a sequence,
so they are strictly contiguous. Anyone who placed one order could walk the whole book:
line items, totals, and other buyers' purchase-order numbers. The mistake was treating a
human-readable reference as a credential. Orders now carry a random access token; the
number stays on the paperwork and is no longer the key.

*Any signed-in user could read, rewrite and cancel anyone else's checkout session.* All
three ACP handlers resolved the viewer and then discarded it; the SQL filtered on id
alone. Authentication without authorization, and the same shape as the one above. The
fix that matters is not the `where user_id = ?` — it is that the actor is now a
**required argument** to every session function, so it cannot be forgotten by a later
caller. There is nothing else to pass.

*Card payments were never recorded.* `markOrderPaid` was exported, correct, and
referenced by exactly one thing in the repository: a test. The webhook handled
subscription events only, so the card path was — take the money, and leave the buyer on
a page reading "nothing has been charged yet", permanently. It was invisible only
because no Stripe key is set on the demo.

**I broke every page in the application with a Content-Security-Policy.** Adding
`script-src 'self'` to the static headers blocks Next's own inline bootstrap scripts,
the ones carrying the RSC payload. The server returned 200, the HTML was in the
response, and nothing ran — every page rendered as an empty body. The e2e suite caught
it inside the same batch, which is the entire argument for having one: a header nobody
exercises is a header nobody notices breaking. The fix is a nonce issued per request in
middleware, using Web Crypto rather than `node:crypto`, which fails the build outright
on the edge runtime.

**The drift detector healed its own alerts.** Reconciliation read state it had written
itself: the first run marked a record `drifted`, the second no longer matched its own
`state = 'synced'` filter, concluded nothing was wrong, and cleared the flag. A standing
billing mismatch would have vanished from the dashboard every night without anyone
fixing it. Drift is now derived only from push-time facts, never from the reconciler's
own outputs. Found by a test that asked whether it was safe to run twice.

**The MCP server never exited when its client disconnected.** It answered correctly over
the pipe and then sat there, because PGlite holds the event loop open. Claude Desktop
would have leaked a process on every reconnect. Only observable from outside the
process, so the regression test spawns a real subprocess — no in-process test could have
seen it.

**Five advisories in the production dependency tree.** `postcss` (three, up to high) came
in transitively through Next, and `nodemailer` (high) was pinned back to v8 to satisfy
an Auth.js peer range that predates the patched release. Both are resolved with pnpm
overrides to the patched versions; `pnpm audit --prod` is clean and CI fails on high.

## The agent, demonstrated

`docs/mcp-session.md` is a **recorded** session, generated by `pnpm mcp:transcript`
rather than written by hand — re-run it and it reproduces, or the documentation is
wrong. Eight exchanges against the stdio server, two of them refusals: a client setting
its own price, and a client reaching for a tool its role does not have. The quote it does
draft comes back priced by the server and `pending_approval`.

The same thing is visible in a browser at `/assistant`, where the trace is the page
rather than a debug panel. A screen recording is still outstanding and is the one
acceptance criterion nothing in this repository can satisfy on its own.

To connect Claude Desktop:

```json
{ "mcpServers": { "tagbridge": {
    "command": "pnpm", "args": ["--silent", "mcp"], "cwd": "/path/to/tagbridge" } } }
```

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
