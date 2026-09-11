# AlgoTerminal — Product Requirements Document

**Status:** v1.0 (pre-implementation)
**Owner:** SamyaDeb
**Context:** Algorand Global x402 Challenge (submission target: MainNet endpoint live and earning before the October measurement window)

---

## 1. Problem statement

Autonomous agents that want to act on Algorand DeFi cannot answer basic comparative questions.

An agent asking *"which Algorand protocol currently generates the most fee revenue per dollar of TVL?"* has to:

1. Discover that Tinyman, Pact, and Folks Finance each expose data differently (Tinyman: a paginated analytics REST API keyed by pool address; Pact: a different paginated REST API with different field names; Folks: a **gated** public API that returns `{"message":"Forbidden"}` to anonymous callers, so its data must be reconstructed from on-chain application state).
2. Learn each protocol's own definition of "fees" — Tinyman reports `last_day_fees_in_usd` (total swap fees, LP + protocol combined); Pact reports `fee_usd_24h` **plus** a separate `pact_fee_bps` protocol cut; Folks reports no USD fee figure at all, only interest rate indices and a retention rate.
3. Decide, itself, whether a lending protocol's "interest paid by borrowers" is comparable to a DEX's "swap fees paid by traders." (It is — but only after a defined normalization step. See `DATA_SCHEMA.md` §3.)
4. Write and maintain three connectors, a units/decimals layer, and a USD pricing layer.

That is a week of engineering per agent, repeated by every agent author, and it silently rots as each protocol changes its API.

**The gap:** there is no standardized, machine-consumable, per-query financial data layer for Algorand DeFi. Token Terminal solved exactly this problem for EVM chains — its actual product is not the data, it is the *methodology* that makes a DEX and a lending protocol comparable on one axis. Nobody has done that for Algorand, and nobody has done it in a form an agent can buy one answer at a time.

**Why now:** x402 on Algorand (GoPlausible facilitator, ~3.3s finality, sub-cent network fees, sponsored fee-payer) makes a $0.005 API call economically real for the first time. A subscription-gated data product is unusable by an agent that needs one number, once. A per-query product is exactly the right shape.

---

## 2. What AlgoTerminal is

A paid HTTP API that answers standardized financial questions about Algorand DeFi protocols, priced per query in USDC, settled over x402.

Three layers of value, in increasing order of defensibility:

| Layer | What it is | Why it's hard to copy | Price |
|---|---|---|---|
| **L1 — Normalized facts** | Cleaned live on-chain/API data: TVL, volume, holders, reserves | Low — it's plumbing, but plumbing nobody wants to maintain | $0.005–0.03 |
| **L2 — Standardized KPIs** | *Our* consistent methodology for revenue, fees, active users, and ratios across DEX / lending / L1 | **High — this is the product.** Requires a defensible, documented, versioned accounting policy | $0.02–0.05 |
| **L3 — Cross-protocol synthesis** | Multi-protocol comparison and natural-language answers reasoning over L2 | Medium-high — only possible *because* L2 exists | $0.05–0.20 |

Everything is computed by us from public sources. We resell no licensed dataset. Our methodology is *modeled on* the public, widely-described Token Terminal approach to KPI standardization; the implementation, formulas, and outputs are our own, and the methodology document (`DATA_SCHEMA.md`) is published so buyers can audit it.

---

## 3. Target users

Primary buyers are **programs**, not people. Ranked by expected share of paid volume:

### 3.1 Portfolio / treasury rebalancing agents *(primary)*
Run on a schedule (hourly–daily). Need `capital_efficiency` and `net_apy` across every venue before moving funds.
- Typical call: `GET /compare?protocols=tinyman,pact,folks&metric=capital_efficiency`
- Willing to pay: $0.05/call is rounding error against a five-figure reallocation.
- Volume shape: low frequency, high value, extremely sticky once integrated.

### 3.2 Yield-routing and LP-optimization bots *(highest call volume)*
Continuously compare fee APR across pools/venues.
- Typical call: `GET /metric/tinyman/fee_apr`, polled per venue.
- Cache-friendly: many bots want the same number in the same 5-minute window. This is what makes the cache layer a margin engine, not just an optimization.

### 3.3 Research and "analyst" agents *(highest revenue per call)*
LLM agents answering human questions about Algorand DeFi.
- Typical call: `POST /ask {"question": "Is Pact or Tinyman capturing more protocol revenue this week, and why?"}`
- Pays $0.15 without negotiating, because the alternative is writing three connectors.

### 3.4 MCP-connected assistants *(distribution channel, not a segment)*
Claude/ChatGPT-style assistants with an MCP server that wraps AlgoTerminal. Each end-user question becomes one paid call. This is our cheapest path to genuine external volume — see §6.

### 3.5 Risk / monitoring agents
Watch utilization and TVL drawdown on lending markets; alert or de-risk on threshold breach.
- Typical call: `GET /metric/folks/utilization?fresh=true` — the one segment that reliably pays the uncached premium.

**Explicit non-user:** the human dashboard visitor. We will ship a landing page (required for discovery metadata), but no charting UI, no login, no seats. If a human wants a chart, they should ask their agent.

---

## 4. Value proposition

**For the agent author:** one endpoint, one schema, one auth story (a signed USDC payment — no API key, no signup, no email, no OAuth), replacing three fragile connectors and an accounting policy they'd have to invent.

**For the agent at runtime:** every metric arrives in the same envelope — `{metric, protocol, value, unit, timestamp, source, confidence}` — so a comparison is a field access, not a research project. `confidence` and `source` are first-class, so an agent can decide whether a number is good enough to trade on. A number we had to estimate is *labeled as estimated*, never laundered into a clean-looking float.

**For the buyer's finance:** $0.005–0.20 per answer, paid only on use, with no minimum, no card, and no subscription. GoPlausible sponsors the Algorand network fee, so the caller needs USDC and nothing else — not even ALGO for gas.

**Positioning sentence:** *Token Terminal's comparability, on Algorand, computed from public data, sold by the query to machines.*

---

## 5. Success metrics

### 5.1 Challenge-window metrics (through the October measurement window)

| Metric | Target | Why this target |
|---|---|---|
| Distinct paying addresses (not ours) | ≥ 25 | The single strongest anti-wash signal: many payers, none of them us |
| Paid calls from external callers | ≥ 5,000 | ~1 call/min sustained from a handful of live bots |
| USDC settled | ≥ $150 | Follows from the above at a blended ~$0.03 |
| Self-originated paid calls | **0 after launch day** | See §7 |
| Share of volume from top payer | ≤ 40% | Concentration is a wash-trading smell even when honest |
| p95 latency, cached route | ≤ 250 ms | Bots time out; a slow oracle is an unused oracle |
| p95 latency, `/ask` | ≤ 6 s | LLM synthesis budget |
| Cache hit rate on `/metric` | ≥ 70% | Gross margin depends on it (§5.3) |

### 5.2 Product-quality metrics

| Metric | Target |
|---|---|
| Connector uptime (all three, per source) | ≥ 99% successful upstream fetch over rolling 24h |
| Stale-serve rate (cache served past TTL because upstream was down) | ≤ 2%, and **always** flagged in the response |
| Metrics with `confidence >= 0.9` | ≥ 60% of the KPI matrix |
| Documented KPI coverage matrix accuracy | 100% — we never advertise a KPI we cannot compute |

### 5.3 Unit economics (the sustainability test)

Per cached `/metric` call at $0.005:
- Revenue: $0.005
- Marginal cost: Redis read + compute ≈ $0.00002; USDC transfer fee sponsored by GoPlausible ≈ $0
- **Gross margin: >99%**

Per `/ask` call at $0.15:
- Revenue: $0.15
- Cost: 1 routing call (Haiku 4.5) + 1 synthesis call (Sonnet 5) over ≤ 4KB of KPI JSON ≈ $0.01–0.03
- **Gross margin: ~80%**

Fixed cost: ~$20/mo (Railway service + Redis + Postgres). **Break-even ≈ 4,000 cached calls/month.** This is the number that makes §6 (post-competition survival) credible rather than aspirational.

---

## 6. Sustained potential (post-competition)

The challenge ends; the API does not. Three things make that real:

1. **The cost floor is ~$20/month.** At the §5.1 volume the service is already profitable, so there is no funding cliff on 1 November.
2. **The connector registry makes coverage mechanical.** Adding protocol #4 is one file implementing one interface (`CONNECTOR_GUIDE.md`), not a refactor. Coverage growth is the growth loop.
3. **Distribution is agent-native and compounding.** `llms.txt`, OpenGraph metadata, the Bazaar listing, and a published MCP server mean discovery happens without a sales motion — an agent that finds us once and gets a clean answer keeps calling.

**Roadmap beyond MVP** (not in scope now, but the architecture must not preclude):
- Historical KPI time series (`?at=<ISO8601>`) — Postgres already snapshots every computed KPI, so this is an endpoint, not a rebuild.
- Connectors 4–8: Algorand L1 itself, a perps/lending venue, an LST protocol, an oracle.
- Webhook/subscription tier paid via x402 `upto` scheme for streaming threshold alerts.
- Methodology versioning (`methodology_version` in every response) so consumers can pin to a stable accounting policy.

---

## 7. Rules compliance and volume integrity

The Official Rules disqualify artificial volume, wash transactions, repeated self-payments, and leaderboard manipulation. This is not a footnote — it is a design constraint that shapes the architecture.

**Binding rules for this project:**

1. **No self-payment after launch verification.** Exactly one mainnet self-payment is permitted, ever: the single real payment required by the submission checklist to confirm USDC receipt and Bazaar listing. It is documented in `DEPLOYMENT.md` with its txid. Every subsequent mainnet payment must originate from a third party.
2. **All our own testing happens on TestNet.** Load tests, integration tests, CI, demos, and the sample agent all point at TestNet USDC (ASA `10458941`). The mainnet endpoint is never a test target.
3. **No paid-call generation by us or on our behalf.** No cron job, no synthetic traffic generator, no "warming" script, no friends-and-family calling loop. If we build a demo agent, it runs on TestNet and its mainnet mode is off by default and off in every recording.
4. **Volume must be pulled, not pushed.** Growth comes from making the product findable and worth calling (MCP server, `llms.txt`, Bazaar description, sample code, free discovery endpoints), never from originating transactions.
5. **Free, unpaid endpoints for evaluation.** `/health`, `/catalog`, `/openapi.json`, `/llms.txt`, and TestNet access are free. An agent must be able to fully evaluate us without paying, so that every mainnet payment represents genuine demand.
6. **Payer concentration is monitored.** If any single payer exceeds 40% of settled volume we investigate before celebrating; a top payer we cannot identify as an independent third party is a red flag we surface, not one we hide.

---

## 8. Non-goals

Explicitly out of scope. Each of these is a real thing someone might expect, and each is a deliberate no.

- **No human-facing dashboard, charts, or web app.** Landing page for discovery metadata only.
- **No accounts, API keys, seats, or subscriptions.** The payment *is* the auth. Adding an API key would make x402 decorative — the opposite of judging criterion #2.
- **No resale or mirroring of any licensed dataset.** Specifically: no Token Terminal API data, no paid data vendor, no scraped paywalled content. Public sources only, cited per-response in the `source` field. Our methodology is inspired by publicly-described standardization practice; our numbers are computed by us.
- **No price oracle product.** We consume prices; we do not sell a price feed and we do not claim oracle-grade guarantees. Prices are an input with their own `confidence`.
- **No trade execution, no custody, no signing on behalf of users.** We receive USDC; we never hold or move a user's funds. This keeps us out of the regulatory surface that a trading product carries.
- **No non-Algorand chains in v1.** The connector interface is chain-agnostic, but scope discipline beats breadth for a MainNet-in-October deadline.
- **No real-time streaming/WebSocket in v1.** Request/response only — it is what x402 fits and what agents poll.
- **No "AI predictions", price targets, or trading signals.** `/ask` synthesizes *observed* standardized data with citations. It never forecasts. A data layer that hallucinates a forecast is worth less than no data layer.
- **No historical backfill in v1.** Snapshots start accumulating at launch. We will not claim history we do not have.
