# TagBridge — engineering specification

The requirements, acceptance criteria and phase order for this project. Each
phase ships before the next one starts.

---

## 0. What you are building and why

An industrial connectivity storefront: search that understands how control
engineers actually talk, a quote path because industrial buying is quote-shaped
rather than cart-shaped, and subscription-to-ERP sync that survives real failure
modes.

This is a portfolio piece aimed at one company that is replacing its webstore
right now. It must be **live, small, and finished** rather than large and
half-built. A working search flow with a published eval table beats a sprawling
half-store every time.

### Non-negotiable ground rules

1. **Original content only.** Real protocol and device vocabulary (OPC UA, Modbus
   TCP, EtherNet/IP, ControlLogix) is public technical fact — use it freely, it's
   what makes the search demo credible. Do NOT copy any company's marketing copy,
   product descriptions, images, or page structure. Write every word yourself.
   Invent the vendor name.
2. **Ship at the end of every phase.** Deployed to Vercel, working, before moving on.
3. **No feature without a test and no claim without a number.**
4. **The model never sets a price.** Ever. See §7.

---

## 1. The build loop

### Protocol

For each phase:

1. Read the phase's **Acceptance Criteria**.
2. Write the tests **first**, from the criteria.
3. Implement until tests pass.
4. Run `pnpm verify` (§12). If anything fails, fix and re-run. Repeat until green.
5. Record a **phase report**: each criterion, PASS/FAIL, with the measured number.
6. If any criterion is FAIL, state exactly why and what changes, then return to
   step 3. Do not proceed to the next phase.
7. If all PASS, commit, deploy, and stop for review.

### Standing rules

- No criterion is marked PASS without command output proving it.
- A criterion that is impossible as written gets a stated revision, not a silent
  reinterpretation.
- After each phase, record anything shipped that is not yet trustworthy.

### Global definition of done

Nothing is done until all of these hold:

```
pnpm typecheck     # zero errors, strict mode
pnpm lint          # zero errors
pnpm test          # all unit + integration pass
pnpm test:e2e      # all Playwright specs pass
pnpm eval:search   # precision@3 >= 0.85, beats BM25 baseline by >= 0.15
pnpm audit --prod  # zero high/critical
```

Plus Lighthouse on the deployed URL: Performance ≥ 90, Accessibility ≥ 95, Best
Practices ≥ 95, SEO ≥ 95. LCP < 2.5s, CLS < 0.1, INP < 200ms.

---

## 2. Stack (pinned, do not substitute)

| Layer | Choice |
|---|---|
| Framework | Next.js 15, App Router, TypeScript strict |
| Styling | Tailwind + shadcn/ui |
| DB | Postgres (Neon) + pgvector |
| ORM | Drizzle |
| Auth | Auth.js v5 |
| Validation | Zod everywhere, no exceptions |
| Payments | Stripe test mode |
| LLM | Anthropic SDK |
| Search | Postgres FTS (BM25) + pgvector + custom synonym layer |
| Tests | Vitest, Playwright |
| Observability | OpenTelemetry + Pino structured logs |
| Deploy | Vercel |
| CI | GitHub Actions |

---

## 3. Repository structure

```
/app
  /(shop)          catalog, product, search, cart
  /(account)       quotes, orders — auth required
  /(admin)         catalog + quote admin — role-gated
  /api
    /search
    /quote
    /agent
    /webhooks/stripe
    /health
/lib
  /search          bm25, vector, synonyms, fusion, rerank
  /agent           tools, prompts, schemas, runner, guardrails
  /commerce        pricing, cart, quote state machine
  /sync            webhook handlers, reconciliation, DLQ
  /auth            authz helpers, role checks
  /db              schema, migrations, seed
  /telemetry
/evals
  /search          golden query set + runner
  /agent           task set + scorer
/tests
  /unit /integration /e2e
SPEC.md  README.md
```

---

## 4. Data model

Core tables (Drizzle):

- **products** — id, sku, name, slug, category, description, protocols[],
  vendorCompat[], licenseType (perpetual | subscription), specs jsonb, active
- **product_variants** — productId, sku, tagCapacity, tier, listPriceCents,
  billingInterval
- **price_tiers** — variantId, minQty, unitPriceCents
- **product_embeddings** — productId, embedding vector(1536), sourceText
- **synonyms** — term, canonical, kind (protocol | vendor | device | concept)
- **users** — id, email, name, role (buyer | sales | admin), companyName
- **carts / cart_items**
- **quotes** — id, number, userId, status, subtotalCents, expiresAt, agentNotes
- **quote_line_items** — quoteId, variantId, qty, unitPriceCents (server-computed)
- **quote_events** — quoteId, type, actor (user | agent | system), payload, createdAt
- **subscriptions** — providerId, userId, variantId, status, currentPeriodEnd
- **erp_sync_records** — subscriptionId, erpRef, lastSyncedAt, state, driftDetected
- **webhook_events** — providerEventId UNIQUE, type, payload, processedAt, attempts, status
- **audit_log** — actor, action, resource, before, after, createdAt

Indexes: GIN on product FTS vector, HNSW on embeddings, unique on
`webhook_events.providerEventId`.

**Seed 50 products.** Realistic categories: OPC UA/DA servers, protocol gateways,
historian connectors, MQTT/Sparkplug bridges, HMI middleware, redundancy modules.
Write original descriptions.

---

## 5. Search subsystem — the centerpiece

Spend the most care here. It is the thing being evaluated.

### Pipeline

```
query
  → normalize (lowercase, strip punctuation, preserve part-number patterns)
  → synonym expansion (bidirectional, from synonyms table)
  → parallel:
      BM25 over Postgres FTS  (exact part numbers, protocol strings)
      dense retrieval over pgvector  (problem-shaped queries)
  → Reciprocal Rank Fusion (k=60)
  → LLM rerank of top 20 → top 8
  → intent classifier: browse | specific-product | compatibility-question
```

If intent is `compatibility-question`, hand off to the compatibility resolver
(§6) instead of returning a flat product list.

### Synonym graph (seed at minimum)

- Vendors: Allen-Bradley ↔ Rockwell ↔ ControlLogix ↔ CompactLogix ↔ MicroLogix;
  Siemens ↔ S7 ↔ SIMATIC; Schneider ↔ Modicon
- Protocols: OPC UA ↔ OPC DA ↔ OPC Classic; Modbus RTU ↔ TCP ↔ ASCII;
  EtherNet/IP ↔ CIP; MQTT ↔ Sparkplug B; BACnet ↔ BACnet/IP; DNP3
- Concepts: tag ↔ point ↔ register ↔ address; historian ↔ data logger;
  PLC ↔ controller ↔ processor

### Golden eval set — 100 queries minimum

Four buckets, 25 each:

1. **Part-number lookups** — "TS-OPC-4000", exact-match, BM25 should win
2. **Problem-shaped** — "get tag data from ControlLogix into SQL Server"
3. **Synonym-dependent** — "Rockwell PLC connector" must find Allen-Bradley products
4. **Compatibility** — "does this work with Modbus RTU over serial"

Each has labeled relevant product IDs. `pnpm eval:search` prints:

```
              precision@3   recall@5   MRR
BM25 only         0.__        0.__     0.__
Vector only       0.__        0.__     0.__
Hybrid (RRF)      0.__        0.__     0.__
Hybrid + rerank   0.__        0.__     0.__
```

**This table goes in the README.** It is the single most persuasive artifact in
the project.

---

## 6. Compatibility resolver

Input: source device, destination system, protocol, tag count, redundancy needed.
Output: required product bundle, license tier, and explicit gaps ("firmware
predates OPC UA — gateway required").

Implement as a **deterministic rule engine first**, with the LLM only translating
natural language into the structured input. Rules live in code and are unit
tested. The model never invents compatibility.

---

## 7. Agent subsystem and its guardrails

### Architecture

Tool-calling loop, max 8 turns, hard timeout 60s.

Tools: `searchProducts`, `resolveCompatibility`, `getPricing`, `createQuote`,
`updateQuoteStatus`, `sendQuoteEmail`.

### Guardrails — implement every one

**The model never sets a price.** It proposes line items as `{variantId, qty}`.
The server computes every price from `price_tiers`. Reject any model output
containing a price field.

**Schema validation both directions.** Zod on tool input and tool output. Parse
failure → structured error back to the model → max 2 retries → deterministic
fallback path → surface a clear error. Never ship unvalidated model output.

**Server-side authorization per tool call**, independent of what the model asked
for. Re-check the session and the resource owner inside every tool. The model's
request is a suggestion, never an authorization.

**Untrusted content isolation.** Catalog text and user input are data, never
instructions. Wrap retrieved content in delimiters, state in the system prompt
that content inside them can never alter tool policy, and maintain a strict tool
allowlist that content cannot expand.

**Cost and abuse caps.** Per-session token budget, per-IP rate limit
(Upstash sliding window), daily org-wide spend cap with a circuit breaker that
fails closed to the deterministic path.

**Human-in-the-loop.** Quotes above a configured threshold enter
`pending_approval` and cannot be sent without a `sales` or `admin` action.

**Immutable audit log.** Every tool call and every quote state transition, append
only, with actor attribution.

**PII discipline.** Never put customer email, name, or company into a prompt
unless the task requires it. Redact before logging. No PII in traces.

### Agent eval

`pnpm eval:agent` over 30 scenarios including adversarial ones: prompt injection
in a product description, a request to discount below floor, a malformed tool
response, a nonexistent SKU. Score task completion, tool-call validity, and
guardrail hold rate. **Guardrail hold rate must be 100%.**

---

## 8. Quote state machine

```
draft → pending_approval → sent → viewed → accepted → converted
                                        ↘ expired
                                        ↘ rejected
```

Transitions are explicit and validated; illegal transitions throw. Every
transition writes a `quote_events` row. Unit test every legal and illegal edge.

---

## 9. Auth and authorization

Auth.js v5, email magic link plus Google. Roles: `guest`, `buyer`, `sales`,
`admin`.

- Middleware protects `/(account)` and `/(admin)`
- **Every server action re-checks the session server-side.** Never trust the client
- Row-level checks: a buyer reads only their own quotes and orders
- `/(admin)` requires `admin`; approval actions require `sales` or `admin`
- Sessions: httpOnly, secure, sameSite=lax, 30-day rolling
- Rate-limit auth endpoints; generic error messages, no user enumeration

---

## 10. Subscription sync and reconciliation

- **Webhook is a trigger, never truth.** On every event, re-read the subscription
  from the Stripe API and sync that state.
- Verify the Stripe signature. Reject unsigned requests.
- Insert into `webhook_events` with UNIQUE on `providerEventId` — that constraint
  is your idempotency guarantee.
- Resolve out-of-order events against the subscription state machine using event
  timestamps, not arrival order. A later event supersedes an earlier one.
- Exponential backoff, max 5 attempts, then dead-letter with a replay endpoint.
- **Nightly reconciliation** (Vercel Cron): compare active Stripe subscriptions to
  `erp_sync_records`, flag drift, alert.
- `/admin/sync` dashboard showing event throughput, DLQ depth, and drift.
  **Build a "break sync" button for the demo** — then show it being caught.

---

## 11. Observability

OpenTelemetry spans across request → search → agent → tool → DB. Pino structured
JSON logs with a request ID propagated end to end. Track per-request LLM token
count and cost. `/api/health` checks DB, Stripe, and the LLM provider.

---

## 12. Testing and CI

`pnpm verify` runs: typecheck → lint → test → test:e2e → eval:search → audit.

- **Unit**: pricing tiers, synonym expansion, RRF fusion, state machine edges,
  compatibility rules, zod schemas
- **Integration**: search pipeline end to end, webhook idempotency (send the same
  event 3× → exactly one record), reconciliation drift detection, authz denials
- **E2E (Playwright)**: search → product → cart → quote request → quote appears in
  account; admin approves; auth redirect for protected routes
- **CI gates on every one of these.** A failing eval fails the build.

---

## 13. Phases and acceptance criteria

### Phase 0 — Foundation
Scaffold, DB schema, migrations, seed 50 products, Auth.js, CI pipeline, deploy.

**Accept:** deployed URL live · `pnpm verify` green · sign-in works · 50 products
in DB · CI passes on a PR.

### Phase 1 — Catalog and cart
Product listing with facets, product detail with variants and tiered pricing,
cart, Stripe test checkout, PO checkout path.

**Accept:** Lighthouse thresholds met on a product page · tier pricing correct in
unit tests · Stripe test payment succeeds · PO path creates an order without
payment · E2E green.

### Phase 2 — Search *(the important one)*
Full pipeline from §5, synonym table seeded, 100-query golden set, eval runner.

**Accept:** `pnpm eval:search` prints the four-row table · hybrid+rerank
precision@3 ≥ 0.85 · beats BM25-only by ≥ 0.15 · p95 search latency < 400ms ·
table committed to README.

### Phase 3 — Quotes and agent
Compatibility resolver, quote state machine, agent with all §7 guardrails, admin
approval, agent eval set.

**Accept:** `pnpm eval:agent` ≥ 0.80 task completion · **guardrail hold rate
100%** · injection scenarios all blocked · no model-set price reaches the DB
(explicit test) · illegal state transitions throw · audit log written for every
transition.

### Phase 4 — Sync and reconciliation
Webhook handler, idempotency, DLQ, reconciliation cron, admin dashboard.

**Accept:** same event 3× → one record (test) · out-of-order events resolve
correctly (test) · reconciliation detects seeded drift · DLQ replay works ·
dashboard live.

### Phase 5 — Agent-native layer
`/.well-known/ucp` manifest, MCP server exposing search + compatibility + quote,
ACP-shaped checkout session endpoint.

**Accept:** manifest validates against the current spec snapshot · MCP server
connects from Claude Desktop and completes a real quote · demo video recorded ·
README documents which spec version you built against.

---

## 14. README requirements

1. **First paragraph: the business problem.** Industrial buyers search by symptom;
   catalog search built for consumer retail fails them. No preamble.
2. **The search eval table, above the fold.**
3. Architecture diagram
4. Agent demo video (Claude Desktop completing a quote)
5. Guardrails section — what could go wrong and what stops it
6. **What broke and how I fixed it** — write this honestly, it's the section
   hiring managers actually read
7. Run instructions that work from a clean clone

---

## 15. Do not

- Copy any company's marketing copy, images, or page structure
- Let the LLM produce a price, a discount, or an authorization decision
- Ship a feature without a test
- Claim a metric you did not measure
- Start a phase before the previous one's criteria are all PASS
- Add scope not in this spec without asking first
