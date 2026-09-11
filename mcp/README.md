# algoterminal-mcp

An MCP server for [AlgoTerminal](https://api-testnet-production-a3ec.up.railway.app/llms.txt) —
standardized financial KPIs for Algorand DeFi protocols, paid per query in USDC over
[x402](https://x402.org).

Ask Claude "how does Tinyman's capital efficiency compare to Folks Finance?" and the question
becomes a real, paid API call, settled on Algorand from **your own wallet**, in about a second.

There is no API key and no signup. **The payment is the authentication.**

---

## What makes the numbers worth paying for

Not the data — the accounting policy. AlgoTerminal applies one consistent policy across every
protocol it covers, so `gross_fees_24h` means the same economic thing for a Tinyman swap fee and a
Folks Finance borrower interest payment. That is what makes `capital_efficiency` comparable between
a DEX and a lending market instead of two unrelated numbers divided by each other. The policy is
published at [`/methodology`](https://api-testnet-production-a3ec.up.railway.app/methodology) and
this server exposes it as a free tool.

Every value comes back as a `KpiFact` with a 0–1 confidence score, a cache state, a staleness flag,
its coverage basis, its provenance, and notes saying what cost it confidence. This server puts all
of that in front of the model as prose rather than burying it in JSON, because the failure mode
worth designing against is a model stripping the caveats and presenting a bare number as fact.

And when a protocol *declines* to publish a KPI — Pact does not disclose its fee split, so it
declines `take_rate` rather than reporting `0.00` — you get the reason, not a zero.

---

## Setup, in under ten minutes

### 1. Get a TestNet account with USDC

The whole thing runs on Algorand **TestNet** by default, where the money is free.

```bash
# Generate an account (or use one you have)
node -e "const a=require('algosdk');const k=a.generateAccount();console.log('addr:',k.addr.toString());console.log('mnemonic:',a.secretKeyToMnemonic(k.sk))"
```

1. **Fund it with TestNet ALGO** at <https://bank.testnet.algorand.network> (paste the address).
   ~1 ALGO is plenty — it covers the minimum balance and the opt-in.

2. **Opt the account in to USDC, ASA `10458941`.** This step is not optional and it is the single
   most common reason an x402 integration appears broken: an Algorand account that has not opted in
   to an asset **cannot hold it**, so every payment fails with an error that looks like a service
   problem. Use [Pera Wallet](https://perawallet.app) (Add Asset → search USDC on TestNet), or:

   ```bash
   algokit task opt-in 10458941 --account <YOUR_ADDRESS>
   ```

3. **Verify the opt-in on chain before concluding anything else is wrong:**

   ```bash
   curl -s "https://testnet-api.4160.nodely.dev/v2/accounts/<YOUR_ADDRESS>" \
     | jq '.assets[] | select(."asset-id" == 10458941)'
   ```

   A record with `"amount": 0` is the **pass** condition. Empty output means you are not opted in.

4. **Get TestNet USDC.** <https://faucet.circle.com> (select Algorand TestNet) works when it works,
   but it is frequently rate-limited. The reliable path is to swap a little of your TestNet ALGO for
   TestNet USDC on a [Tinyman V2 TestNet](https://testnet.tinyman.org) pool.

You need **USDC only — no ALGO for gas.** The GoPlausible facilitator sponsors the Algorand network
fee on every payment. (Your account still needs a little ALGO for its own minimum balance.)

### 2. Point your client at the server

**Claude Desktop** — `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`,
Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "algoterminal": {
      "command": "npx",
      "args": ["-y", "algoterminal-mcp"],
      "env": {
        "ALGOTERMINAL_MNEMONIC": "your twenty five word testnet mnemonic goes here ...",
        "ALGOTERMINAL_MAX_SPEND_USDC": "1.00",
        "ALGOTERMINAL_MAX_PER_CALL_USDC": "0.05"
      }
    }
  }
}
```

**Claude Code** — `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "algoterminal": {
      "command": "npx",
      "args": ["-y", "algoterminal-mcp"],
      "env": {
        "ALGOTERMINAL_KEYFILE": "~/.algoterminal/payer.key",
        "ALGOTERMINAL_MAX_SPEND_USDC": "1.00",
        "ALGOTERMINAL_MAX_PER_CALL_USDC": "0.05"
      }
    }
  }
}
```

Restart the client. That is the whole setup.

### 3. Check it works — without spending anything

Ask: **"What does AlgoTerminal cover, and what does it cost?"**

That calls `algoterminal_catalog`, which is free. If you see the three protocols and their prices,
you are done. Then ask `algoterminal_spend` (also free) to confirm your payer address is recognized
and your USDC balance is where you think it is.

---

## Tools

| Tool | Cost | What it does |
|---|---|---|
| `algoterminal_catalog` | **free** | Live coverage, prices, route availability, and every declined KPI with its reason. Call this first. |
| `algoterminal_methodology` | **free** | How a KPI is defined, and *why* it is comparable across a DEX and a lending market. |
| `algoterminal_spend` | **free** | Cumulative spend, the caps, itemized receipts, payer balance and opt-in status. |
| `algoterminal_get_metric` | **$0.005** ($0.02 with `fresh`, $0.03 for `active_users_24h`) | One KPI for one protocol. |
| `algoterminal_compare` | **$0.05** ($0.08 with `fresh`) | One KPI across 2–5 protocols, ranked, with comparability caveats. |
| `algoterminal_ask` | **$0.15** ($0.20 deep) | A natural-language question answered from measured facts. **Registered only if the deployment reports the route available** — it is currently disabled upstream, so you will not see this tool yet. |

Prices in the tool descriptions are read live from `/catalog` at startup, not hardcoded, so the cost
the model reasons about is the cost the service will actually quote.

Coverage is read live too. As of this writing: **tinyman** (dex, 11 KPIs), **pact** (dex, 6),
**folks** (lending, 12) — but ask `algoterminal_catalog` rather than trusting this table.

---

## Spend controls

An agent in a loop is the threat model. A model that decides to "check every KPI for every protocol"
makes 29 paid calls without pausing.

| Variable | Default | Effect |
|---|---|---|
| `ALGOTERMINAL_MAX_PER_CALL_USDC` | `0.05` | Refuses any single call quoted above this. |
| `ALGOTERMINAL_MAX_SPEND_USDC` | `1.00` | Refuses the call that would push the session total above this. |

Both are enforced against **the amount the server actually quotes in its 402**, not against a price
from the catalog — checked in a hook that runs *before* any transaction is built or signed. A
refused call spends nothing, signs nothing, and reaches no chain.

Calls are **refused, never truncated.** There is no "spend what is left" path. When a cap refuses a
call, the tool says what it would have cost, how much is left, and which variable to change — and it
tells the model not to retry, because it would be refused identically.

Every paid tool result ends with a running total:

```
PAID: 0.050000 USDC for GET /compare?protocols=tinyman,pact,folks&metric=capital_efficiency.
Settlement txid: APSA6QQJGGFOO4RKIJ5M3CEX62ONIYTSHLF63XXU64SU3YTHO2SA
Explorer: https://testnet.explorer.perawallet.app/tx/APSA6QQJGGFOO4RKIJ5M3CEX62ONIYTSHLF63XXU64SU3YTHO2SA
SESSION SPEND: 0.055000 USDC of 1.000000 cap (0.945000 remaining, 2 paid call(s) this session).
```

The caps are per **session**: they reset when the MCP server restarts, which for most clients means
when you restart the client. They are not a lifetime budget. Your wallet balance is the real one.

### Note on the default per-call cap

`0.05` is exactly the price of a `/compare`. So out of the box, `compare` works and
`compare?fresh=true` ($0.08) is refused, as is `/ask` ($0.15). That is deliberate — the expensive
tiers should be a decision you make, not a default you discover. Raise the cap if you want them.

---

## Errors cost you nothing

This is unusual enough to be worth stating plainly: **AlgoTerminal settles payment only after a
successful response.** A 404, a 422, a 502, a timeout — none of them are charged. Not "refunded",
not "credited": never settled in the first place.

Concretely:

- **404 `KPI_NOT_APPLICABLE`** — the protocol declines this KPI. Carries the reason and the list of
  KPIs it *does* publish. Free. This server answers most of these from the free catalog without even
  making the request.
- **422** on `/ask` — out of scope (a forecast, a price target) or unroutable. Free. Probe freely.
- **502 `INSUFFICIENT_DATA`** — fewer than two legs of a comparison resolved, so it declined rather
  than sell you a one-way "comparison". Free.
- **504** — a slow handler outlived the payment window, usually on `fresh=true` or
  `active_users_24h`. Free. Retry, or drop `fresh` and take the cached number.

So "try again" is genuinely free advice here, and the tool results say so every time.

---

## Configuration reference

| Variable | Default | Notes |
|---|---|---|
| `ALGOTERMINAL_MNEMONIC` | — | 25-word mnemonic of **your** Algorand account. |
| `ALGOTERMINAL_KEYFILE` | — | Path to a file containing that mnemonic. `#` comment lines and line wrapping are fine, and a leading `~` is expanded — an MCP config is JSON, not a shell, so nothing else would expand it. Takes second place to `ALGOTERMINAL_MNEMONIC`. |
| `ALGOTERMINAL_MAX_SPEND_USDC` | `1.00` | Session cap. |
| `ALGOTERMINAL_MAX_PER_CALL_USDC` | `0.05` | Per-call cap. Must not exceed the session cap. |
| `ALGOTERMINAL_NETWORK` | `testnet` | `testnet` or `mainnet`. Switches the USDC ASA and the chain id together. |
| `ALGOTERMINAL_BASE_URL` | the TestNet deployment | Required if you set `ALGOTERMINAL_NETWORK=mainnet`, which has no default deployment yet. |
| `ALGOTERMINAL_ALGOD_URL` | Nodely public node | Algod used to **build** the payment transaction. |
| `ALGOTERMINAL_TIMEOUT_MS` | `60000` | Per-request timeout. |

Without a key, the server still starts and the three free tools work normally. The paid tools
explain how to configure one rather than failing obscurely.

### Two chains, and they are different

The **data** describes Algorand **MainNet** protocols — real Tinyman pools, real Folks markets. The
**payment** settles on whichever chain `ALGOTERMINAL_NETWORK` names, TestNet by default. Evaluating
on TestNet means paying play money for real MainNet numbers, which is the point of the free
evaluation surface.

MainNet is not live yet. When it is, switching is one environment variable plus a base URL.

---

## Your key stays yours

This server ships **no funded account** and proxies payments through **no service wallet**. It signs
with the key you supply, from the account you control, and the mnemonic never leaves your machine —
it goes to your algod node to build a transaction and nowhere else. AlgoTerminal never sees it.

That is not incidental. It is the whole proposition of x402, and paying on users' behalf would also
be exactly the self-generated volume the Algorand Global x402 Challenge disqualifies.

Treat the mnemonic like any other secret. Prefer `ALGOTERMINAL_KEYFILE` with mode `0600` over an
inline value in a config file, and use a dedicated account funded with only what you intend to spend
— on TestNet or MainNet alike.

---

## No caching, on purpose

This server does not cache anything. AlgoTerminal already caches with per-KPI TTLs and reports
`cache` and `stale` on every fact — that freshness signal is part of what you are paying to see. A
second cache in front of it would report a stale number as a fresh hit and hide the exact thing the
service goes out of its way to tell you.

---

## Development

```bash
npm install
npm test          # 96 tests, entirely offline — nothing reaches the network
npm run typecheck
npm run build
```

The suite covers tool schemas as a real MCP client receives them, both spend caps (including
enforcement against a genuine parsed 402), free tools never triggering a payment, the error-code
mapping, and a mocked paid call asserting the `KpiFact` reaches the model with its confidence and
notes intact. `test/harness.ts` throws on any unstubbed request: a test that reached the live service
would spend real money.

## Verified live

Run on 2026-09-09 against the deployed TestNet service, driven over stdio exactly as Claude Desktop
drives it. Payer `P6ZZ5IFTPP6YZ5NMI2WMVFZBQGVGBDSX4RMJXDPMNOQSHEG3WTHPE53APA`.

| Tool call | Price | Settlement |
|---|---|---|
| `algoterminal_compare` `{tinyman,pact,folks, capital_efficiency}` | $0.05 | [`APSA6QQJ…O2SA`](https://testnet.explorer.perawallet.app/tx/APSA6QQJGGFOO4RKIJ5M3CEX62ONIYTSHLF63XXU64SU3YTHO2SA) |
| `algoterminal_get_metric` `{folks, tvl}` | $0.005 | [`PSYUF3Q6…67CA`](https://testnet.explorer.perawallet.app/tx/PSYUF3Q66OXVVUKR4V73WHPFMRZWKMIUMW6OKAOFCZ4UXXOY67CA) |
| `algoterminal_get_metric` `{pact, take_rate}` | — | declined; answered free from the catalog, carrying Pact's reason verbatim |
| `algoterminal_get_metric` `{tinyman, tvl}` with the cap at $0.001 | — | **refused**, nothing signed, nothing spent |

Every settlement confirmed on chain as an `axfer` of ASA 10458941 to the service's `payTo`, with
`"fee": 0` — the facilitator paid the network fee, as advertised. The session counter tracked the
wallet exactly: the payer's USDC balance fell by `0.055000` across the first run and a further
`0.005000` across the second, matching the counter to the last decimal place, and the refused call
moved neither.

Reproduce it yourself with `ALGOTERMINAL_MNEMONIC='<25 words>' node live-e2e.mjs`.

## License

MIT
