# TagBridge — an agent-native industrial commerce storefront

**The one-line pitch:** a storefront for industrial connectivity software where a
maintenance engineer can search by the *problem* they have, and where an AI agent
can discover, configure, quote, and check out the entire catalog without a human
ever opening the UI.

Live at: `tagbridge.vercel.app` (yours to claim)

---

## Why this one, for this company

Software Toolbox is rebuilding their storefront right now. Their spec asks for
"search that understands industrial vocabulary" — the single hardest thing on
their list, and the thing your RAG and retrieval work actually solves. They also
want you to own Rosie, their quote-to-cash agent, and to sync subscriptions from
a merchant of record into an ERP.

So build all three, plus one thing they didn't ask for.

**The unasked-for thing is the hook.** In 2026 a stack of agentic commerce
standards went live: UCP (Shopify + Google, launched at NRF in January, covering
discovery through post-purchase via a `/.well-known/ucp` manifest, self-serve
since June), ACP (OpenAI + Stripe, Apache 2.0, narrowly the checkout session),
and AP2 (Google, donated to the FIDO Alliance in April, using W3C Verifiable
Credentials for a signed Intent → Cart → Payment chain). MCP sits underneath as
the data layer.

Adoption so far is consumer retail — Walmart, Target, Etsy, Wayfair. Industrial
B2B is untouched. A company with 6,000 customers in 75 countries replacing
ERP-bundled commerce in 2026 should be asking whether their new storefront is
agent-discoverable. You arrive having already built the answer.

*These specs are beta and moving fast — verify the current schema at build time
and say so in your README. "Built against the 2026-04-17 ACP snapshot" reads as
rigor, not hedging.*

---

## What it does

### 1. Search that actually understands industrial vocabulary

The core problem: engineers don't search for products, they describe symptoms.
*"Get tag data from a ControlLogix into SQL Server."* *"Modbus device won't talk
to my SCADA."* *"Need OPC UA on a legacy DA server."*

Build a hybrid retrieval layer:
- BM25 for exact part numbers and protocol strings, which embeddings fumble
- Dense vector search for problem-shaped queries
- A domain synonym graph: Allen-Bradley ↔ Rockwell ↔ ControlLogix ↔ CompactLogix;
  OPC DA ↔ OPC UA ↔ OPC Classic; EtherNet/IP ↔ CIP; MQTT ↔ Sparkplug B;
  Modbus RTU ↔ Modbus TCP ↔ Modbus ASCII
- Reranking, and an evaluation set of ~100 real-shaped queries with labeled
  correct products

**Publish the eval table in the README.** Hybrid vs BM25-only vs embeddings-only,
precision@3. That table is what separates you from everyone who wired up a vector
DB and called it search.

### 2. Compatibility resolver — the actual B2B problem

Industrial buying isn't add-to-cart, it's *"will this work with what I already
have?"* Build an agent that takes source device, destination system, protocol,
and tag count, then returns the required product bundle, license tier, and the
gaps ("your PLC firmware predates OPC UA — you need the gateway too").

This is why industrial commerce is quote-shaped rather than cart-shaped, and
showing you understand that is worth more than any feature.

### 3. Quote-to-cash agent (your Rosie)

Cart becomes a quote. An agent drafts it with line items and tiered pricing,
validates against typed tool contracts, writes a structured deal into a mock CRM,
tracks quote state, and follows up on a schedule — escalating to a human only
when confidence is low or deal value is high, not on every step.

Wrap it in an evaluation harness scoring task completion and tool-call validity,
run as CI regression checks.

### 4. The agent-native layer — the part nobody else has

- **`/.well-known/ucp` manifest** publishing catalog, cart, and checkout
  capabilities so an agent can discover the store
- **MCP server** exposing search, compatibility resolution, and quote generation
  as callable tools — connect it to Claude Desktop and demo an agent buying
  industrial software in a conversation
- **ACP-shaped checkout session endpoint** with the merchant remaining system of
  record for orders, tax, and compliance
- A **video of an agent completing a purchase end to end**, embedded in the README

### 5. Subscription sync middleware — proof of the note you sent them

The thing you described in your application note, built:
- Stripe test-mode subscriptions as the merchant-of-record stand-in
- Webhooks as triggers, provider API as truth
- Idempotent handlers keyed on event ID; state machine resolving out-of-order
  events; dead-letter queue with replay
- Nightly reconciliation sweep comparing provider state to the mock ERP
- **A live drift dashboard** — deliberately break the sync during your demo and
  show it being caught

### 6. Commerce fundamentals

Tiered and variant pricing, perpetual vs subscription licensing, a purchase-order
checkout path alongside cards, server-side event instrumentation with a funnel
view, abandoned-cart capture.

---

## Stack

Their stack, deliberately: **Next.js on Vercel**, TypeScript, Tailwind, Postgres
with pgvector (Neon or Supabase), Stripe test mode, Python or TypeScript for the
agent layer, MCP SDK, OpenTelemetry.

---

## Catalog data

**Build a fictional catalog.** Do not scrape Software Toolbox's product pages or
reuse their copy — showing up with their own content repackaged is a bad first
impression and an IP problem.

Invent 40–60 products across realistic categories: OPC servers, protocol
gateways, historian connectors, HMI/SCADA middleware, licensing tiers. Ground
them in genuinely public protocol and device vocabulary, which is what makes the
search problem real. Name the company something else entirely.

---

## Build order

| Phase | Ship | Days |
|---|---|---|
| 1 | Next.js storefront live on Vercel: catalog, product pages, variant/tiered pricing, cart, Stripe test checkout | 4–5 |
| 2 | Hybrid search + synonym graph + eval table in README | 3–4 |
| 3 | Quote path, quote-to-cash agent, mock CRM deal write | 3–4 |
| 4 | Subscription sync middleware + drift dashboard | 2–3 |
| 5 | UCP manifest, MCP server, ACP checkout endpoint, agent demo video | 3–4 |

**Deploy at the end of phase 1 and keep deploying.** A live URL that improves
weekly beats a perfect one that launches in a month — and it means you can apply
after five days instead of three weeks.

---

## README structure

They said a shipped project beats a transcript, so the README is the interview.

1. **First paragraph: the business problem.** Industrial buyers search by symptom;
   catalog search built for consumer retail fails them. One sentence, no preamble.
2. **One quantified result at the top.** Precision@3 of hybrid vs baseline.
3. Architecture diagram
4. The agent demo video
5. The search eval table
6. **What broke and how you fixed it** — the section hiring managers actually read
7. Run instructions

---

## The line for your application

> I built a working answer to the hardest bullet in your spec. TagBridge is a
> Next.js storefront where search understands industrial vocabulary — hybrid
> retrieval with a protocol and vendor synonym layer, benchmarked against
> keyword-only search — plus a quote-to-cash agent and webhook-driven
> subscription sync into a mock ERP. It also publishes a UCP manifest and an MCP
> endpoint, so an AI agent can discover, configure, and quote the catalog without
> touching the UI. That last part is the bet: agentic commerce standards landed
> in 2026 and industrial B2B hasn't moved yet. You're rebuilding your storefront
> now, so it seemed worth showing rather than describing.
