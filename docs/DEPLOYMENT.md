# AlgoTerminal — Deployment Runbook

**Status:** v1.0 (pre-implementation)
**Target:** live paid endpoint on Algorand MainNet, settling through the GoPlausible facilitator, listed in the Bazaar, appearing on the challenge leaderboard.

Work top to bottom. Every step has a verification command whose output you must actually read — a step is done when its check passes, not when the command exits 0.

---

## 0. Prerequisites

| Thing | Value / where |
|---|---|
| Node | 22 LTS |
| Railway account | project + Redis + Postgres |
| Domain | `algoterminal.xyz` (or equivalent) with DNS you control |
| Anthropic API key | for `/ask` routing + synthesis |
| Algorand wallet | for the `payTo` account (see §2) |
| Facilitator | `https://facilitator.goplausible.xyz` |

**Constants — do not retype these by hand anywhere except `src/config/x402.ts`:**

```
ALGORAND_MAINNET_CAIP2 = algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=
ALGORAND_TESTNET_CAIP2 = algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=
USDC_MAINNET_ASA       = 31566704   (6 decimals)
USDC_TESTNET_ASA       = 10458941   (6 decimals)
SCHEME                 = exact
X402_VERSION           = 2
ALGOD_MAINNET          = https://mainnet-api.4160.nodely.dev
INDEXER_MAINNET        = https://mainnet-idx.4160.nodely.dev
```

---

## 1. Confirm the facilitator supports what you're about to build

Do this **first**. Everything downstream assumes it.

```bash
curl -s https://facilitator.goplausible.xyz/supported | jq .
```

Confirm the response includes the Algorand MainNet CAIP-2 identifier above and the `exact` scheme. Then read the live OpenAPI at `https://facilitator.goplausible.xyz/docs` and diff the `/verify` and `/settle` request shapes against what `@x402/avm` sends. If they disagree, the facilitator is the source of truth — pin the package version that matches and note it in the repo.

### 1.1 What it actually returned (checked 2026-09-09, build step 6)

`/supported` lists both Algorand networks with the `exact` scheme at `x402Version: 2`, in the **full genesis-hash** CAIP-2 form this document uses:

```jsonc
{ "x402Version": 2, "scheme": "exact",
  "network": "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
  "extra": { "feePayer": "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA" } }
{ "x402Version": 2, "scheme": "exact",
  "network": "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
  "extra": { "feePayer": "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA" } }
```

`extra.feePayer` is the **same sponsor address on both networks**, and it is read from this response at runtime rather than configured — `src/config/x402.ts` holds no fee-payer constant, because the only source that can be right about whose address sponsors the fee is the facilitator that will sign with it.

**Pinned versions.** `@x402/core`, `@x402/avm`, `@x402/hono`, `@x402/extensions` and `@x402/fetch` are all pinned to **exactly `2.25.0`** (no caret) in `package.json`. The `/verify` and `/settle` request shapes in the live OpenAPI — `{ paymentPayload, paymentRequirements }` returning `{ isValid, invalidReason }` and `{ success, transaction, network, errorReason }` — are what `HTTPFacilitatorClient` at that version sends and parses. They agree, so no override was needed.

**One naming difference, resolved in the facilitator's favour.** `@x402/avm` defines its canonical CAIP-2 ids **truncated to 32 characters** of the genesis hash (`algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe`), per the CAIP-2 Algorand namespace profile. The facilitator advertises the **full** hash. We register and quote the full form — it is what `/supported` returns, what our docs specify and what goes on the wire — and the package accepts it everywhere via `normalizeAlgorandNetwork`, which maps the full form onto its own canonical key for default-asset lookup. Registering the truncated form instead would fail to match `/supported` and the 402 would never be built.

**A MainNet cost note, for step 5.** `/settle` documents a free-tier quota that our base price sits under: sub-cent settlements (< $0.01) get **1000 free settles per `payTo` account per chain per UTC month**; beyond that the account needs Settlement Units, bought at `/sponsorship/purchase/{10|100|1000}`. Settlements ≥ $0.01, all verifies, all self-fee-paying settlements and **all testnets** are unlimited. Our `/metric` base route is $0.005, so this binds on MainNet at the 1001st base-route sale in a month — see §5.

---

## 2. Create and prepare the `payTo` account

The `payTo` address is the identity that appears on the leaderboard. Treat it as a production key from the first minute.

1. **Generate a fresh account.** Do not reuse a personal wallet. This account's entire transaction history becomes public evidence of how the entry earned its volume; a clean, single-purpose account is both better operational hygiene and a clearer compliance record.
2. **Fund it with ALGO for the minimum balance.** 0.1 ALGO base + 0.1 ALGO per ASA opt-in. Send ~1 ALGO.
3. **Opt in to USDC (ASA 31566704).** This is mandatory — an account that has not opted in **cannot receive the asset**, and every payment to it will fail. Do this before the endpoint is reachable, not after the first customer arrives.

   Opt-in is a 0-amount asset transfer to self:

   ```bash
   # via algokit (or any wallet's "add asset" flow)
   algokit task opt-in 31566704 --account <PAYTO_ADDRESS>
   ```

4. **Verify the opt-in on chain before proceeding:**

   ```bash
   curl -s "https://mainnet-api.4160.nodely.dev/v2/accounts/<PAYTO_ADDRESS>" \
     | jq '.assets[] | select(."asset-id" == 31566704)'
   ```

   You must see a record with `"asset-id": 31566704` and `"amount": 0`. **Empty output means you are not opted in.** Stop and fix it.

5. **Repeat all of the above on TestNet** with ASA `10458941`, using a separate TestNet account. Fund from the Algorand TestNet dispenser.

6. **Key handling.** The `payTo` *address* goes in config and is public. The mnemonic is never needed by the service — AlgoTerminal only *receives*. Store it offline. If the service ever needs a signing key for `payTo`, something is wrong with the design.

---

## 3. Provision infrastructure (Railway)

```
Project: algoterminal
  ├── service: api          (this repo, Node 22)
  ├── plugin:  Redis        (cache L1)
  └── plugin:  Postgres     (ledger + kpi_snapshots)
```

Environment variables on `api`:

```bash
NODE_ENV=production
X402_NETWORK=mainnet                    # 'testnet' on the staging service
X402_PAYTO=<PAYTO_ADDRESS>
X402_FACILITATOR_URL=https://facilitator.goplausible.xyz
ALGOD_URL=https://mainnet-api.4160.nodely.dev
INDEXER_URL=https://mainnet-idx.4160.nodely.dev
REDIS_URL=${{Redis.REDIS_URL}}          # Railway reference variable — REQUIRED
DATABASE_URL=${{Postgres.DATABASE_URL}} # Railway reference variable — REQUIRED
ANTHROPIC_API_KEY=<key>
METHODOLOGY_VERSION=1.2.0
PUBLIC_BASE_URL=https://api.algoterminal.xyz
LOG_LEVEL=info
```

`src/config/env.ts` validates all of these with zod **at boot** and refuses to start if any is missing or malformed. `REDIS_URL` and `DATABASE_URL` went from optional to required at build step 5: Redis is L1 and holds the stampede lock, Postgres is L2, and a service that boots without them serves every paid call from a ~65 s upstream fetch — unprofitable at \$0.005 and unusable at any price (`ARCHITECTURE.md` §4.5). `ANTHROPIC_API_KEY` is **optional even now that `/ask` exists**, and deliberately so: `/ask` is one route, not the product, and a deployment without a key still serves `/metric`, `/compare` and every free route. What it must not do is *sell* a route it cannot serve, so an unconfigured deployment does not gate `/ask` (no 402 is quoted for it), `/llms.txt` marks it not yet live, `/openapi.json` marks it `x-available: false`, `/health` reports `ask.configured: false`, and the handler itself answers `503 ASK_NOT_CONFIGURED`. Set the key and the route appears with no other change. A service that starts with a blank `X402_PAYTO` will emit 402s pointing at nowhere and quietly collect zero dollars — fail loud instead.

**Run two services from one repo:** `api` (mainnet) and `api-testnet` (testnet), differing only in `X402_NETWORK` and `X402_PAYTO`. Everything we test goes to `api-testnet` (`PRD.md` §7.2).

> **[corrected 2026-09-09] `ALGOD_URL` and `INDEXER_URL` stay on MAINNET for both services.** This paragraph previously said the two services also differ in their algod/indexer URLs, and `api-testnet` was deployed that way. It is wrong, and it was wrong in a way that returned numbers rather than errors.
>
> **The chain our data lives on is not the chain our payments settle on.** `X402_NETWORK` selects the payment rail, and `src/config/x402.ts` derives its *own* `algodUrl`/`indexerUrl` from that constant — the payment path never reads `env.ALGOD_URL`. That variable is consumed in exactly one place, `src/connectors/context.ts`, to build the `ConnectorContext` the connectors read protocols with. Those protocols are on mainnet: Tinyman's validator apps, Pact's pools, and every Folks lending market.
>
> Pointed at testnet, the connectors did not fail — they under-reported:
>
> | connector | symptom on testnet URLs |
> |---|---|
> | `pact` | unaffected; it is pure REST to `api.pact.fi` |
> | `tinyman` | **silently truncated.** The §3.3 V2 walk returns **0** accounts opted into validator app `1002541853` on testnet against thousands on mainnet, so TVL fell back to the V1.1 half — roughly $183k instead of $5.4M, with no error anywhere |
> | `folks` | every market `404`s (pool manager `971350278` does not exist on testnet), so `/health` reported `folks: down` |
>
> Folks is what surfaced it: it is the only connector whose `healthCheck` reads chain state, so it is the only one that could tell the difference between "the wrong network" and "a quiet day". The Tinyman case is the one that matters — a wrong number served silently is worse than a connector that reports itself down.
>
> Corrected on `api-testnet` 2026-09-09: `ALGOD_URL`/`INDEXER_URL` set to mainnet, `X402_NETWORK=testnet` unchanged. Re-verified after the redeploy: `/health` `status: ok` with all three connectors `ok`, and the 402 challenge still advertises the testnet genesis hash, testnet USDC (`10458941`) and the same `payTo`.

Postgres schema:

```sql
CREATE TABLE payments (
  payment_txid  text PRIMARY KEY,      -- the caller's signed payment txn; known before verify
  txid          text UNIQUE,           -- the facilitator's settlement txid; NULL on settle_failed
  payer         text NOT NULL,
  amount_atomic bigint NOT NULL,
  asset_id      bigint NOT NULL,
  route         text NOT NULL,
  network       text NOT NULL,
  settled_at    timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL CHECK (status IN ('settled', 'settle_failed')),
  payload       jsonb,                 -- the payment payload, kept only on a failure row
  error_reason  text                   -- the facilitator's reason, when it gave one
);
CREATE INDEX ON payments (payer);
CREATE INDEX ON payments (settled_at);
CREATE INDEX ON payments (status, settled_at DESC);

CREATE TABLE kpi_snapshots (
  id                  bigserial PRIMARY KEY,
  protocol            text NOT NULL,
  metric              text NOT NULL,
  value               double precision,
  unit                text,
  confidence          real,
  methodology_version text NOT NULL,
  as_of               timestamptz NOT NULL,
  fact                jsonb NOT NULL,
  params_hash         text NOT NULL,
  UNIQUE (protocol, metric, params_hash, as_of)
);
CREATE INDEX ON kpi_snapshots (protocol, metric, params_hash, methodology_version, as_of DESC);
```

**`params_hash` was added at build step 5**, when `kpi_snapshots` became the L2 cache tier. The original key, `UNIQUE (protocol, metric, as_of)`, assumes one value per KPI per instant, and that is false: `DATA_SCHEMA.md` §3.6 defines a `basis`, so `tinyman/tvl?basis=verified_only` and `?basis=all_pools_usd_priced` are two different numbers describing the same protocol at the same moment. Under the original key the second one to arrive loses the `ON CONFLICT` race silently, and an L2 fallback then answers a `verified_only` request with the all-pools figure — a wrong number wearing a correct envelope. It is the same hash that appears in the L1 cache key (`src/cache/keys.ts`), so both tiers are keyed on one identity.

`methodology_version` leads the index because the L2 read filters on it, for the same reason the L1 key contains it: a 1.0.0 snapshot is a different measurement from a 1.1.0 one. Old rows stay for `/history`; they are simply not reachable as a fallback for the running version.

**Schema changes are applied by migration, never on boot.** `migrations/*.sql` are applied in filename order by `npm run migrate`, tracked in `schema_migrations`, and serialised with a Postgres advisory lock so two instances migrating at once cannot both apply the same file. Run it as a pre-deploy command, not from `start`: a schema change is a deploy step with its own success and its own rollback, and folding it into boot makes a schema change and a code change succeed or fail as one unreviewable unit.

The pre-deploy command is declared in `railway.json`, in the repo, so it is reviewable in a diff rather than living in a dashboard field nobody can see:

```json
{ "deploy": { "preDeployCommand": ["npm run migrate:prod"] } }
```

`migrate:prod` runs `node dist/db/migrate-cli.js`, not `tsx`. The deploy image is built with `--omit=dev`, so `tsx` is not installed in it — a `scripts/*.ts` entrypoint would fail the deploy at exactly the step that exists to make schema changes safe. That is why the migration entrypoint lives in `src/db/` and is compiled by `npm run build`; `migrations/` resolves relative to the module, so `dist/db/` and `src/db/` read the same files.

**`payments` gained `payment_txid`, `payload` and `error_reason` at build step 6**, when the gate that writes to it was built. Same reasoning as `params_hash` above: the original shape could not express something the design requires.

The original key was `txid`, the settlement transaction id. But `ARCHITECTURE.md` §5.2 requires a row for a settle that **failed** after a successful handler — and a failed settle has no settlement txid to key on. Under the original key those rows could not be written at all, which is precisely the silent revenue loss §5.2 exists to make visible. `payment_txid` is the id of the caller's own signed payment transaction, derived from the `PAYMENT-SIGNATURE` payload before verify runs. It exists for every payment we ever see, succeeded or failed, which makes it the only column that can be the identity of a payment — and it is also what the 409 `payment_replayed` guard needs, since that guard must answer "have I seen this before?" *before* doing any work, at which point the settlement txid does not exist yet. `txid` is kept, nullable and unique, because it is what an operator pastes into an explorer.

`payload` is §5.2's "write a `settle_failed` ledger row **with the payment payload** for reconciliation" — reconciling a failed settle by hand means chasing the group on chain, and the payload is the only artifact that survives the failure. It is null on a settled row, where the settlement txid is the receipt. `error_reason` is the facilitator's own reason: a settle-failure rate with no reasons attached tells an operator that something is wrong but not what.

`payments` is the record you will use to reconcile against the leaderboard and to compute payer concentration (`PRD.md` §7.6). Do not skip it.

---

## 4. Deploy and verify on TestNet first

Every submission requirement is validated here before a single mainnet cent moves.

```bash
railway up --service api-testnet
railway domain --service api-testnet     # → testnet.algoterminal.xyz
```

**Checks, in order:**

```bash
# 1. Free routes work and require no payment
curl -s https://testnet.algoterminal.xyz/health   | jq .status      # "ok"
curl -s https://testnet.algoterminal.xyz/catalog  | jq '.protocols[].id'
curl -s https://testnet.algoterminal.xyz/llms.txt | head -20
curl -s https://testnet.algoterminal.xyz/openapi.json | jq '.openapi, (.paths|keys)'
# `ask.configured` must be true, and `ask.methodology_document` must be true —
# the latter is the only check that catches a build which did not ship
# docs/DATA_SCHEMA.md, since the JSON rendering of /methodology is generated
# from code and works either way.
curl -s https://testnet.algoterminal.xyz/health | jq '.ask'
curl -s "https://testnet.algoterminal.xyz/methodology?format=markdown" | head -3

# 2. A paid route returns a well-formed 402
curl -si https://testnet.algoterminal.xyz/metric/tinyman/tvl \
  | tee /tmp/402.txt | head -1                                       # HTTP/2 402
grep -i '^payment-required:' /tmp/402.txt | cut -d' ' -f2 \
  | base64 -d | jq .
```

Verify in that decoded JSON: `scheme: "exact"`, the **TestNet** CAIP-2 id, `asset: "10458941"`, `amount` matching the advertised price in atomic units, your TestNet `payTo`, and a populated `extra.feePayer`.

```bash
# 3. Full paid round-trip with a real x402 client
#    (@x402/fetch, TestNet USDC, funded test account)
SMOKE_BASE_URL=https://<testnet-service> \
TESTNET_PAYER_MNEMONIC='<funded testnet account>' \
SMOKE_DATABASE_URL=<public postgres url, optional> \
npm run testnet:smoke
```

`npm run testnet:accounts` prepares the two accounts this needs first: it opts `payTo` in to USDC (mandatory — an account that has not opted in cannot receive the asset) and tells you what still needs funding.

The smoke script must assert, and print, all of:
- 402 received, requirements parsed
- payment group built (fee-payer txn unsigned at index 0, signed axfer at index 1)
- `/verify` accepted
- 200 with a schema-valid `KpiFact`
- `PAYMENT-RESPONSE` header decodes to `success: true` with a txid
- the txid is visible on TestNet: `https://testnet.explorer.perawallet.app/tx/<txid>`
- a `payments` row exists with status `settled`
- **a deliberately failing request (`/metric/tinyman/nonexistent_kpi`) returns 404 and writes NO payments row** — this is the settle-after-success guarantee, and it is the one behavior worth proving explicitly rather than assuming
- replaying the settled `PAYMENT-SIGNATURE` returns 409 `payment_replayed`. This doubles as an outside-in proof that the settled row exists, so the check holds even when the database is not reachable from where the script runs

Also exercise `/compare` and `/ask` on TestNet, and confirm cache hit rate climbs above 0.7 on `/health` once the refresher has run for ten minutes.

---

## 5. MainNet cutover

Only after §4 is fully green.

**Before the 1001st sub-cent sale of any UTC month**, read §1.1's quota note. The `/metric` base route is $0.005, which is under the facilitator's $0.01 sub-cent threshold, so it draws on a free allowance of 1000 settles per `payTo` per chain per month. Past that, settles return 429 with `errorReason: subcent_quota_exceeded` and a `Retry-After` to the monthly reset — which our gate treats as a settle failure: the caller still gets its data, we still eat the loss, and `/health` shows the failure rate climbing. Settlement Units are bought at `/sponsorship/purchase/{10|100|1000}`, and the settle response warns via an `X-Subcent-Quota` header from about 90% usage. That header is worth watching from the first mainnet day rather than the day it bites.

```bash
railway variables --service api --set X402_NETWORK=mainnet
railway up --service api
railway domain --service api             # → api.algoterminal.xyz
```

**Pre-flight (all must pass):**

```bash
curl -s https://api.algoterminal.xyz/health | jq '.status, .connectors'
curl -si https://api.algoterminal.xyz/metric/tinyman/tvl | grep -i '^payment-required:' \
  | cut -d' ' -f2 | base64 -d | jq '.accepts[0]'
```

Assert on the decoded output:
- `network` is `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=` — **not** the TestNet id
- `asset` is `"31566704"` — **not** `10458941`
- `payTo` is the MainNet address you opted in at §2.4
- `amount` is `"5000"` for the $0.005 route

Getting the network right here is the single highest-consequence check in this document: a mainnet endpoint quoting TestNet requirements collects nothing, appears on no leaderboard, and looks fine from the outside.

### 5.1 The one permitted self-payment

The submission checklist requires at least one real MainNet payment confirming USDC receipt. That is **one** transaction, and it is the only self-originated mainnet payment this project will ever make (`PRD.md` §7.1).

```bash
node scripts/mainnet-verify-once.ts     # single call, $0.005, refuses to run twice
```

Record immediately, in `docs/LAUNCH_LOG.md`:

```markdown
## MainNet verification payment
- Date: <ISO 8601>
- Route: GET /metric/tinyman/tvl
- Amount: 0.005 USDC (5000 atomic units, ASA 31566704)
- Payer: <address>
- payTo: <PAYTO_ADDRESS>
- TxID: <txid>
- Explorer: https://explorer.perawallet.app/tx/<txid>
- Purpose: submission requirement — confirm USDC receipt and trigger Bazaar cataloging.
- This is the ONLY self-originated mainnet payment for this project.
```

The script must be built to hard-refuse a second run (a committed marker file plus a check against the `payments` table). Not because a second call would be catastrophic in itself, but because "just one more test on mainnet" is exactly how an entry drifts into the pattern the rules disqualify. Make the guardrail structural, not a note in a doc.

Confirm receipt on chain:

```bash
curl -s "https://mainnet-api.4160.nodely.dev/v2/accounts/<PAYTO_ADDRESS>" \
  | jq '.assets[] | select(."asset-id" == 31566704) | .amount'      # 5000
```

---

## 6. Discovery: Bazaar, OpenGraph, llms.txt

Per the Algorand best-practices guide, **there is no manual Bazaar registration** — cataloging begins automatically once a real mainnet transaction lands, and the enrichment engine re-fetches metadata daily. What you control is the quality of what it indexes. Expect directory updates within about a day of a change.

### 6.1 Bazaar discovery declaration (in the 402 response)

Already specified in `API_SPEC.md` §2.1. Every paid route's 402 must carry a `discovery` block with:
- a one-sentence `description` written for an agent, not a human
- `tags` including **`x402-global-challenge`** (required for challenge tracking)
- `input_example` and `output_example` — a concrete request and a concrete response

Verify each route's block renders correctly:

```bash
for r in /metric/tinyman/tvl /compare /ask; do
  echo "== $r"
  curl -si "https://api.algoterminal.xyz$r" | grep -i '^payment-required:' \
    | cut -d' ' -f2 | base64 -d | jq '{description, discovery}'
done
```

### 6.2 `/llms.txt`

Served at `https://api.algoterminal.xyz/llms.txt`, per llmstxt.org. Written for an agent deciding whether to spend money:

```markdown
# AlgoTerminal

> Standardized financial KPIs for Algorand DeFi protocols, priced per query in
> USDC over x402. Built for autonomous agents and trading bots.

Covers Tinyman, Pact, and Folks Finance with one consistent accounting policy,
so a DEX and a lending market are directly comparable. Data is computed by us
from public on-chain and public-API sources. No API key, no signup, no
subscription — the payment is the authentication.

## Payment
- Protocol: x402 v2, scheme `exact`
- Network: Algorand MainNet (`algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=`)
- Asset: USDC, ASA 31566704 (6 decimals)
- Facilitator: https://facilitator.goplausible.xyz
- Network fee sponsored by the facilitator — you need USDC only, no ALGO.
- Payment is settled only after a successful response. Errors are never charged.

## Free endpoints (no payment)
- /health — service and connector status
- /catalog — every protocol and KPI we can answer, generated from live capabilities
- /openapi.json — full spec
- /methodology — how every KPI is defined and computed
- TestNet: https://testnet.algoterminal.xyz — identical API, TestNet USDC (ASA 10458941)

## Paid endpoints
- GET /metric/{protocol}/{kpi} — $0.005 (cached) / $0.02 (?fresh=true)
- GET /compare?protocols=a,b&metric=x — $0.05
- POST /ask {"question": "..."} — $0.15

## Response shape
Every value is a KpiFact:
{metric, protocol, value, unit, timestamp, as_of, source[], confidence,
 is_estimated, methodology_version, coverage, notes[]}
`confidence` >= 0.9 is safe to act on. Estimates are always labeled.

## Example
curl https://api.algoterminal.xyz/metric/tinyman/capital_efficiency
→ 402 with payment requirements; pay and retry with PAYMENT-SIGNATURE.

## What we do not do
No forecasts, no price targets, no trading advice, no custody, no execution.
Descriptive standardized data only.
```

### 6.3 Landing page and OpenGraph

The enrichment engine fetches these daily. Build the page crawler-first, human-second.

```html
<title>AlgoTerminal — Standardized Algorand DeFi KPIs, priced per query in USDC</title>
<meta name="description" content="Agent-native financial data layer for Algorand DeFi. Standardized TVL, fees, revenue, and comparable ratios across Tinyman, Pact, and Folks Finance. Paid per query in USDC via x402.">
<meta property="og:title" content="AlgoTerminal">
<meta property="og:description" content="Standardized financial KPIs for Algorand DeFi, priced per query in USDC over x402. Built for autonomous agents.">
<meta property="og:image" content="https://algoterminal.xyz/og-banner.png">
<meta property="og:url" content="https://algoterminal.xyz">
<meta property="og:type" content="website">
<link rel="icon" href="/favicon.png">
```

Page content, in order: one-sentence what-it-is; the price table; a copy-pasteable curl; the `KpiFact` schema; a link to `/methodology`; a link to the TestNet base URL. No marketing copy above the fold — the first reader is a crawler and the second is an agent's operator evaluating integration in thirty seconds.

Add `og-banner.png` (1200×630) and a logo. The enrichment engine uses both for the directory card, which is the first thing a browsing agent operator sees.

### 6.4 Confirm the listing

Within ~24h of the §5.1 payment:
- The endpoint appears in the Bazaar directory with the correct title, description, and image.
- The `x402-global-challenge` tag is present.
- The `payTo` address appears on the challenge leaderboard.

If any of these is missing after 48h, re-check that the tag is in the 402 `discovery` block on **every** paid route, that OpenGraph tags resolve on the public URL, and that the verification txid is confirmed on MainNet — then contact the organizers with the txid.

---

## 7. Post-launch operations

### 7.1 Daily

```bash
curl -s https://api.algoterminal.xyz/health | jq '{status, connectors, cache, facilitator}'
```

Investigate immediately if: any connector's 24h success rate < 0.95, cache hit rate < 0.5 (margin risk), or `settle_failures_1h > 0` (silent revenue loss and a leaderboard discrepancy).

### 7.2 Weekly — volume integrity review

This is a compliance control, not a metrics ritual (`PRD.md` §7.6).

```sql
-- Payer concentration: is any single caller dominating?
SELECT payer,
       count(*)                                        AS calls,
       sum(amount_atomic) / 1e6                        AS usdc,
       round(100.0 * sum(amount_atomic) / SUM(sum(amount_atomic)) OVER (), 1) AS pct
FROM payments
WHERE status = 'settled' AND settled_at > now() - interval '7 days'
GROUP BY payer ORDER BY usdc DESC;

-- Sanity: our own addresses must never appear after the §5.1 verification txn.
SELECT * FROM payments WHERE payer IN ('<OUR_TEST_ADDRESSES>');
```

If a single payer exceeds 40% of settled volume, identify it before treating the number as a win. If the second query returns anything beyond the one logged verification payment, stop and investigate — that is the failure mode that disqualifies an entry.

### 7.3 Upstream drift watch

The connectors depend on third-party API shapes that can change without notice. Zod validation failures are logged at WARN with the offending payload. A sustained rise in `coverage.excluded` or a spike in schema-drift warnings means a source changed — refresh the fixtures, fix the connector, and re-run the golden tests before the bad data reaches a paid response.

### 7.4 Growth (pull, never push)

Permitted: publish an MCP server wrapping the API; post working sample code; write up the methodology; answer questions where agent builders already are; keep `/llms.txt` and OpenGraph current.

**Not permitted, under any framing:** generating calls ourselves, paying anyone to call, running a bot that calls on a timer, or asking others to call for volume rather than for value. Volume must be a consequence of the product being worth money. This is both the rule and, given that judging weights use-case quality and sustained potential equally with volume, the strategy.

---

## 8. Rollback

```bash
railway rollback --service api           # previous deployment
```

The payment gate and the connectors fail independently by design: if a connector breaks, `/metric` for that protocol returns 502 and does not settle, while other protocols keep serving. There is no scenario in which a rollback should require touching the `payTo` account, and no scenario in which the correct fix is to disable the payment gate. If serving traffic requires bypassing payment, take the endpoint down instead — an entry that briefly served unpaid data is worse off than one that was briefly offline.
