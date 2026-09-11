# AlgoTerminal — Launch Log

The evidence trail `DEPLOYMENT.md` §5.1 requires at mainnet cutover. Every
entry records what was actually observed, with a link anyone can re-check.
Started at build step 7 (the TestNet round trip) rather than at cutover,
because an evidence trail assembled after the fact is not evidence.

**Rule for this file:** nothing is written here that was not read off a live
service, a live facilitator or the chain. Pending items stay marked pending.

---

## 1. TestNet accounts

Created 2026-09-09. Fresh, single-purpose accounts — no personal wallet reused
(`DEPLOYMENT.md` §2.1).

| Role | Address | Purpose |
|---|---|---|
| `payTo` (service) | `BKRGZZ32PRF6XV7PFJAFM47MF37FPWG6YTT5ONM3OJEUE2HUYZHBZA55UQ` | Receives every TestNet payment. Configured as `X402_PAYTO`. |
| `payer` (buyer)   | `P6ZZ5IFTPP6YZ5NMI2WMVFZBQGVGBDSX4RMJXDPMNOQSHEG3WTHPE53APA` | The paying agent in `scripts/testnet-smoke.ts`. |

Both addresses pass `algosdk.isValidAddress` — alphabet **and** trailing
checksum. The previous `X402_PAYTO` did not, which is why `npm run
testnet:accounts` refused to boot; that was the boot-time validator working as
designed (`DEPLOYMENT.md` §3).

### Key handling

- Mnemonics live in `~/.algoterminal/testnet-keys.env`, mode `0600`, **outside
  the repository**. The service never needs them: AlgoTerminal only *receives*
  (`DEPLOYMENT.md` §2.6).
- `.env` is ignored by `.gitignore:3` and has never been tracked.
- History audited, not just the working tree: every blob in `git rev-list
  --all` was scanned for a 25-word mnemonic pattern. **0 hits.** The only
  `.env*` path ever committed is `.env.example`.

### Funding and opt-in status

| Check | payTo | payer |
|---|---|---|
| ALGO balance | **5.000000** | **4.999000** |
| USDC opt-in (ASA 10458941) | **yes** | **yes** |
| USDC balance | 0 (correct — payTo only receives) | **PENDING** |

Opt-in transactions, 2026-09-09:

| Account | Opt-in TxID | Explorer |
|---|---|---|
| payTo | `A7N5S4B2LLBE54POLSPB7WFJ3KAMM3ACNT5R6MAUAFXGBRAMH5XA` | https://testnet.explorer.perawallet.app/tx/A7N5S4B2LLBE54POLSPB7WFJ3KAMM3ACNT5R6MAUAFXGBRAMH5XA |
| payer | `SDRO3WMWLFDA6W3PLDHLDYHSB4DGI4ZD5ZUNQHUS7DDJLP6KUJSA` | https://testnet.explorer.perawallet.app/tx/SDRO3WMWLFDA6W3PLDHLDYHSB4DGI4ZD5ZUNQHUS7DDJLP6KUJSA |

§2.4 verification, run against both accounts — a record with `"amount": 0`,
which is the pass condition:

```json
[ { "amount": 0, "asset-id": 10458941, "is-frozen": false } ]
```

Verification command (`DEPLOYMENT.md` §2.4) — a record with `"amount": 0` is
the pass; **empty output means not opted in and every payment would fail**:

```bash
curl -s "https://testnet-api.4160.nodely.dev/v2/accounts/BKRGZZ32PRF6XV7PFJAFM47MF37FPWG6YTT5ONM3OJEUE2HUYZHBZA55UQ" \
  | jq '.assets[] | select(."asset-id" == 10458941)'
```

---

## 2. Facilitator

Read live from `https://facilitator.goplausible.xyz/supported` on 2026-09-09:

| Network | CAIP-2 | `extra.feePayer` |
|---|---|---|
| TestNet | `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=` | `ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA` |
| MainNet | `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=` | `ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA` |

Same sponsor on both networks, `scheme: exact`, `x402Version: 2` — matching
`DEPLOYMENT.md` §1.1. `scripts/testnet-smoke.ts` asserts the 402's
`extra.feePayer` against this address **and** re-reads `/supported` in the same
run, so the literal cannot rot silently if the sponsor rotates.

---

## 3. TestNet deployment

- Railway project `algoterminal`, service `api-testnet`, environment `production`.
- URL: `https://api-testnet-production-a3ec.up.railway.app`

| Check | Status |
|---|---|
| `/health` returns `ok` over public HTTPS | **ok** — `status: ok`, connector `tinyman: ok` |
| `/catalog` lists `tinyman` with TestNet asset `10458941` | **ok** — `asset: "10458941"`, `network: algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=`; no mention of the MainNet ASA `31566704` anywhere in the document |
| A paid route returns `402` | **ok** — `HTTP 402` on `/metric/tinyman/tvl` |
| `X402_PAYTO` is the real payTo above | **ok** — set on the service and confirmed in the live 402 after redeploy |

The service had been running with a *different* placeholder payTo
(`ADJYDJZ2KUVK6SJKCYV3UXIC4L3PMFKBKBUUTBPX545NHJ4WR6K4OTOKQU`). It passed the
boot-time checksum validator, so nothing failed loudly — but it is not an
account we control or have opted in, so every settle would have targeted an
address that cannot receive USDC. Replaced 2026-09-09; the variable change
alone did not roll out, an explicit redeploy was needed.

---

## 4. TestNet paid round trip

Run 2026-09-09 with `npm run testnet:smoke` against the **deployed** service —
`https://api-testnet-production-a3ec.up.railway.app`, not localhost. Live
GoPlausible facilitator, real TestNet USDC, real chain.

**Result: all checks passed.**

| Assertion | Result |
|---|---|
| 402 carries TestNet CAIP-2 `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=` | ok |
| asset `10458941`, amount `5000`, payTo `BKRGZZ32…ZA55UQ` | ok |
| `extra.feePayer` = `ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA`, cross-checked against live `/supported` in the same run | ok |
| `X-PAYMENT-REQUIRED` v1 alias carries identical bytes | ok |
| Payment group: **unsigned** fee-payer at index 0, **signed** axfer at index 1, `paymentIndex` 1 | ok |
| Fee-payer is a 0-amount self-payment by the sponsor; payer spent no ALGO on fees | ok |
| 200 with a schema-valid `KpiFact` | ok |
| `PAYMENT-RESPONSE` decodes to `success: true` with a txid matching the payment txn | ok |
| Txid confirmed on chain (round 67130023) | ok |
| **payTo USDC increased by exactly 5000 atomic units** (40000 → 45000) | ok |
| Buyer debited exactly 5000 (3952450 → 3947450) | ok |
| Replayed `PAYMENT-SIGNATURE` → 409 `payment_replayed` | ok |
| **404 writes NO `payments` row** — replaying its payment returns 404, not 409 | ok |
| **Buyer's USDC unchanged across the 404** (3947450 → 3947450) | ok |
| No `PAYMENT-RESPONSE` on the failed request | ok |
| Underpayment → 402 `payment_insufficient`, `required: 5000`, `provided: 1000` | ok |
| `?fresh=true` quoted at 20000 **and the axfer moves 20000** | ok |
| payTo increased by exactly 20000 on the fresh call (45000 → 65000) | ok |

### Transactions

| Purpose | TxID | Explorer |
|---|---|---|
| Base route settlement, 5000 units | `433GKCLSSW25MCLHI6I32DUUNRSSPLESTBDRKO7476BMTTSZYJPQ` | https://testnet.explorer.perawallet.app/tx/433GKCLSSW25MCLHI6I32DUUNRSSPLESTBDRKO7476BMTTSZYJPQ |
| `?fresh=true` settlement, 20000 units | `5NWT27Z7IVUVKD7DDOIBXQG57KDU6P6LFSU3KHQMCP72MWCDT7WA` | https://testnet.explorer.perawallet.app/tx/5NWT27Z7IVUVKD7DDOIBXQG57KDU6P6LFSU3KHQMCP72MWCDT7WA |

Five further settlements of the same shape came from earlier runs of the same
script during that session (rounds 67129948–67129991), bringing the total to
seven at the time this section was written. Four more were added by the §4b
re-verification runs, for eleven in all; they are reconciled against the chain
and the ledger below, which is the use `DEPLOYMENT.md` §3 wants `payments` put
to.

### payTo USDC balance

| Point | Atomic units |
|---|---|
| Before any payment | 0 |
| Before the first recorded round trip | 40000 |
| After the 2026-09-09 recorded round trip | 65000 |
| After the two re-verification runs (§4b) | **115000** |

On-chain total received by payTo across all eleven settlements: **115000 atomic
units** — matching the balance exactly, with no unaccounted transfer.

### Funding note — how the buyer got its USDC

`faucet.circle.com` was rate-limited ("Limit exceeded, more test tokens in 2
hours") and never dispensed. The buyer was funded instead by swapping TestNet
ALGO for TestNet USDC on the Tinyman V2 TestNet ALGO/USDC pool
(`UDFWT5DW3X5RZQYXKQEMZ6MRWAEYHWYP7YUAPZKPW6WJK3JH3OZPL7PO2Y`, reserves
~5,364 ALGO / ~42,968 USDC):

| Swap | 0.5 ALGO → 3.992450 USDC |
|---|---|
| TxID | `BVRTPSHSI2CPMBWE5JLHJTIXUEQGKUO2GZZACVMCJKTKWYWC3J3Q` |
| Explorer | https://testnet.explorer.perawallet.app/tx/BVRTPSHSI2CPMBWE5JLHJTIXUEQGKUO2GZZACVMCJKTKWYWC3J3Q |

### The `payments` ledger, read directly

Queried on the deployed Postgres over a Railway tunnel, 2026-09-09, after the
§4b re-verification runs:

```sql
select status, count(*) n, sum(amount_atomic) total from payments group by status;
```

```
 status  | n  | total
---------+----+--------
 settled | 11 | 115000
```

**Eleven rows, every one `settled`, summing to 115000 atomic units.** Two further
integrity queries returned on the same connection:

| Query | Result | Meaning |
|---|---|---|
| `count(*) where error_reason is null` | **11** | no row records a failure |
| `count(*) where payment_txid is distinct from txid` | **0** | the caller's signed payment txn *is* the settled txn, on every row |

Three independent facts agree, which is what makes this evidence rather than a
number in a table:

1. **The ledger matches the chain.** The indexer reports exactly **11** inbound
   USDC transfers to payTo totalling **115000** — the same count and the same
   sum the ledger holds.
2. **The ledger matches the payTo balance.** 115000 received, 115000 held,
   nothing unaccounted.
3. **`payment_txid` equals `txid` on every row**, the same identity the smoke
   test asserts from the receipt side.

Reconciliation command:

```bash
curl -s "https://testnet-idx.4160.nodely.dev/v2/accounts/$PAYTO/transactions?asset-id=10458941&limit=100" \
  | jq '[.transactions[] | select(."asset-transfer-transaction".receiver==$ENV.PAYTO and ."asset-transfer-transaction".amount>0)]
        | {count: length, total: map(."asset-transfer-transaction".amount)|add}'
# => { "count": 11, "total": 115000 }
```

### What did NOT write a row

Across every run in this session the service answered **eight** requests that
were paid for but not fulfilled — four `/metric/tinyman/nonexistent_kpi` 404s
and four underpayments refused at `/verify`. **None of them produced a row**,
and none moved USDC.

That is the settle-after-success guarantee, confirmed three ways: the row count
(11 — the exact number of 2xx paid responses, not 19), the payTo balance, and
the outside-in replay probe (replaying a settled payment returns 409; the 404's
payment returns 404, because the ledger has nothing to match it against).

`ARCHITECTURE.md` §3's claim — *"settled volume equals successfully-served
requests"* — is now a measured fact on this deployment, not a design intention.

---

## 4b. Independent re-verification, 2026-09-09

§4 was recorded by the session that performed the original run. Because an
evidence trail whose only witness is its own author is weak, the whole block was
re-run from a clean session, against the same deployed URL, with the numbers
re-read from chain rather than carried forward.

**Two full runs of `npm run testnet:smoke` against
`https://api-testnet-production-a3ec.up.railway.app`. Both exited 0 with every
assertion `ok` and no `fail` lines.**

Checked first, independently of the script, with plain `curl` against public
HTTPS:

| Check | Observed |
|---|---|
| `/health` | `200`, `status: ok`, connector `tinyman: ok` |
| `/catalog` | `200`, `tinyman` present, `payment.asset: "10458941"`, `network: algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=` |
| `/metric/tinyman/tvl` unpaid | `402`, both `PAYMENT-REQUIRED` and the `X-` alias |
| Decoded 402 | `amount 5000`, `asset 10458941`, `payTo BKRGZZ32…ZA55UQ`, `extra.feePayer ZMFK2OI7…BA67RA22AA`, `decimals 6` |

Then the script's own assertions, all green in both runs:

| Assertion group | Result |
|---|---|
| Free routes (`/health`, `/catalog`, `/llms.txt`) demand no payment | ok |
| 402: TestNet CAIP-2, asset `10458941`, amount `5000`, real payTo | ok |
| `extra.feePayer` matches the literal **and** a live `/supported` re-read in the same run | ok |
| Payment group: 2 txns, **unsigned** fee-payer at index 0, **signed** axfer at index 1, `paymentIndex 1` | ok |
| Fee-payer is a 0-amount self-payment by the sponsor, fee ≥ 2000 uALGO; payer spent no ALGO | ok |
| `200` with a schema-valid `KpiFact`, cache + methodology headers present | ok |
| `PAYMENT-RESPONSE` decodes to `success: true`; receipt txid == payment txid | ok |
| Txid confirmed on chain | ok |
| **payTo USDC increased by exactly 5000**; buyer debited exactly 5000 | ok |
| Replayed `PAYMENT-SIGNATURE` → `409 payment_replayed` | ok |
| **404 writes NO row** — its payment replays as 404, not 409 | ok |
| **Buyer's USDC unchanged across the 404** | ok |
| No `PAYMENT-RESPONSE` on the failed request | ok |
| Underpayment → `402 payment_insufficient`, `required 5000`, `provided 1000`, with the facilitator's own reason | ok |
| `?fresh=true` quoted at 20000 **and the axfer moves 20000** | ok |
| payTo increased by exactly 20000 on the fresh call | ok |

### Re-verification transactions

| Run | Purpose | TxID | Explorer |
|---|---|---|---|
| 1 | base, 5000 | `VJB2PEIKDI2NPGORB4T2EWPMZLXO7SM4SHLRPEBUQVV455SKD3TA` | https://testnet.explorer.perawallet.app/tx/VJB2PEIKDI2NPGORB4T2EWPMZLXO7SM4SHLRPEBUQVV455SKD3TA |
| 1 | `?fresh=true`, 20000 | `ZYPHBYBKSPUF2HRXEVEPYZMUO6DZKZTS4PBD2LJABKTJUFFP55ZQ` | https://testnet.explorer.perawallet.app/tx/ZYPHBYBKSPUF2HRXEVEPYZMUO6DZKZTS4PBD2LJABKTJUFFP55ZQ |
| 2 | base, 5000 | `6OFOVNFHMHGDGCWYLFTR5OVGFN5B7MFYPRI7GQPCHM3E3KGWP23A` | https://testnet.explorer.perawallet.app/tx/6OFOVNFHMHGDGCWYLFTR5OVGFN5B7MFYPRI7GQPCHM3E3KGWP23A |
| 2 | `?fresh=true`, 20000 | `2QRD42KZ5O3MVMYDZ7NZAU5UY5JDZI2MZBUF23EXSERY5Z66C3MA` | https://testnet.explorer.perawallet.app/tx/2QRD42KZ5O3MVMYDZ7NZAU5UY5JDZI2MZBUF23EXSERY5Z66C3MA |

Balance movement across the two runs, read from chain at each step by the
script itself:

| Point | payTo | payer |
|---|---|---|
| Before run 1 | 65000 | 3927450 |
| After run 1 base settlement | 70000 | 3922450 |
| Across run 1's 404 | 70000 | 3922450 *(unchanged — the guarantee)* |
| After run 1 `?fresh=true` | 90000 | 3902450 |
| After run 2 base settlement | 95000 | 3897450 |
| Across run 2's 404 | 95000 | 3897450 *(unchanged)* |
| After run 2 `?fresh=true` | **115000** | **3877450** |

### Key hygiene, re-audited

Not taken from the earlier entry — re-run in this session:

| Check | Result |
|---|---|
| `.env` tracked by git? | **no** — ignored at `.gitignore:3`; `git ls-files` matches only `.env.example` |
| `.env.example` carries a real payTo or mnemonic? | **no** — `X402_PAYTO=` is empty |
| Mnemonic anywhere in history? | **0 hits** — every blob in `git rev-list --objects --all` scanned for a 25-word pattern |
| Only `.env*` path ever added in history | `.env.example` |
| Mnemonic storage | `~/.algoterminal/testnet-keys.env`, mode `0600`, outside the repo |

## 4b. `/compare` — the partial-settle boundary, paid on TestNet

Run 2026-09-09 against the deployed `api-testnet`
(`https://api-testnet-production-a3ec.up.railway.app`) with
`scripts/compare-smoke.ts`. Every figure below was read from the live service,
the chain, or the deployed Postgres — the ledger via `railway ssh --service
Postgres`, since Railway's Postgres has no public endpoint, so the rows counted
are the ones the running service actually wrote.

`API_SPEC.md` §3.2 makes the partial-result rule a *payment* rule, so it is
recorded here rather than only in the test suite: the question is not what
status code came back, it is whether money moved.

| Query | HTTP | Settled | New rows |
|---|---|---|---|
| `?protocols=tinyman,pact,folks&metric=capital_efficiency` | 200, `partial: false` | **yes** | 1 × 50000 |
| `?protocols=tinyman,pact,folks&metric=take_rate` | 200, `partial: true`, `excluded_protocols: ["pact"]` | **yes** | 1 × 50000 |
| `?protocols=tinyman,pact&metric=utilization` | 422 `KPI_NOT_APPLICABLE_TO_ANY` | **no** | **0** |

- `payments` rows: **13 → 15**. Both new rows are `route = /compare`,
  `amount_atomic = 50000`, `status = settled`.
- Payer USDC: **3777450 → 3677450**, i.e. **100000 atomic units = 2 × $0.05**.
  The 422 moved nothing, and carried no `PAYMENT-RESPONSE` header at all.
- The 422 was reached *after* a valid payment was verified — the caller paid,
  the gate verified, the handler declined, and settle never ran. That is the
  ordering guarantee (`ARCHITECTURE.md` §5.2) doing the thing it exists for,
  measured rather than asserted.

Both 200s reported `cache: "hit"`, which is the §6 design working: `/compare` is
composed from the same cached facts `/metric` serves and is never cached as a
unit, so a comparison costs three cache reads rather than three upstream walks
(7.5 s and 6.7 s end to end, against ~112 s for the same three legs cold).

### The flagship number

`GET /compare?protocols=tinyman,pact,folks&metric=capital_efficiency`

| Rank | Protocol | Class | `capital_efficiency` | Confidence | `coverage.basis` |
|---|---|---|---|---|---|
| 1 | tinyman | dex | **0.073653** | 0.70 | `all_pools_usd_priced` (409 included, 22,214 excluded) |
| 2 | pact | dex | **0.036365** | 0.81 | `all_pools_usd_priced` (88 included, 3,873 excluded) |
| 3 | folks | lending | **0.018662** | 0.81, `is_estimated` | `total_deposits` (25 of 25 markets) |

`spread`: max 0.073653, min 0.018662, ratio **3.9468**.
`comparability.confidence`: **0.70** — the minimum, which is Tinyman's, not the
0.77 the three would have averaged to.

Consistent with `DATA_SCHEMA.md` §6's worked example (Tinyman 0.0754, Folks
0.0196), measured a few hours apart on the same day.

**Is the ranking defensible?** The one objection that could overturn it is the
denominator: Folks' TVL is total deposits while the DEXes' is pool liquidity,
and those are different definitions (§3.5). That objection is checkable rather
than rhetorical. Restating Folks on the strictest alternative definition —
deposits minus borrows, which is DefiLlama's — multiplies its ratio by
36,958,555 / 24,500,059 = **1.51**, giving **0.0282**. Still third, still below
Pact's 0.0364 and less than half of Tinyman's 0.0737. The ordering is invariant
to the only definitional choice that could plausibly move it, and the gaps
(4.0× top to bottom, 2.0× between the two DEXes, which share a basis exactly)
are an order of magnitude larger than the definitional wobble. It is defensible.

## 4c. `/openapi.json` and `/methodology` — verified against the built artifact

Run 2026-09-09 against `node dist/index.js` — the compiled output, booted from
`.env` with the real connector registry, real Redis and real Postgres. Not the
test suite and not `tsx`: the deploy image runs `dist/`, and the two things most
likely to break between `src/` and `dist/` are exactly what these routes depend
on — a runtime file read (`docs/DATA_SCHEMA.md`) and a relative path that
resolves differently one directory deeper.

| Check | Result |
|---|---|
| `/openapi.json` validates against the OpenAPI 3.1 meta-schema | **yes**, offline, in CI (`@hyperjump/json-schema`) |
| Paths published | 8, exactly the `src/pricing.ts` table |
| `x-price-usdc` per route | `0.005` / `0.05` / `0.15`, read from `priceAtomic` |
| `x-x402.network` | `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=` (TestNet) |
| Components generated from zod | 14, every `$ref` resolves |
| `/methodology` JSON `document_version` vs `METHODOLOGY_VERSION` | **1.2.0 == 1.2.0** |
| `/methodology?format=markdown` | 54,738 bytes, **byte-identical to `docs/DATA_SCHEMA.md`** |
| `Accept: text/markdown` | negotiates; `?format=` overrides; `?format=yaml` is a 400 |
| `/metric`, `/compare` still quote a 402 | yes, `PAYMENT-REQUIRED` present on both |

Two drifts were found by the version-agreement test rather than by review, and
both had been latent for five commits:

- `test/setup.ts` still declared `METHODOLOGY_VERSION=1.1.0` after Folks shipped
  1.2.0.
- `src/cache/testing.ts` stamped a literal `1.1.0` on every fixture fact, while
  L2's read predicate pins `env.METHODOLOGY_VERSION` (`src/cache/snapshots.ts`).
  Fixtures were therefore writing snapshot rows the real read path could not
  see. Nothing failed, because the two literals agreed with each other.

Both now track the configured version.

## 4d. `/ask` — built, tested, and NOT enabled

`POST /ask` is merged and covered by 72 tests, and it has **never been run
against a real model.** There is no `ANTHROPIC_API_KEY` for this project, so
the four paid questions in the build brief were not executed, the prose was
never read, and the cost per call was never measured. That is recorded here
rather than smoothed over: the route is unverified in the one dimension that
matters most for it.

What IS verified, against `dist/`:

| Check | Result |
|---|---|
| `/health` `ask.configured` | `false` |
| `/health` `ask.methodology_document` | `true` (the `.railwayignore` negation works) |
| `POST /ask` unconfigured | `503 ASK_NOT_CONFIGURED`, **no 402 quoted** |
| `/llms.txt` | marks `POST /ask` `_(not yet live)_` |
| `/openapi.json` | `"x-available": false` on the `/ask` operation |
| `/metric` and `/compare` | unaffected — still gated, still quoting 402s |

This is the designed degradation, not a workaround: `gatedRoutes()` excludes
`/ask` when no key is configured, so a deployment cannot quote $0.15 for a
route it would then fail. Setting the variable is the only change needed to
turn it on, and §4e below is the verification that must run before it is.

**Unmeasured, and therefore unclaimed:** the cost per `/ask` call, and with it
`PRD.md` §5.3's ~80% gross-margin assumption for this route. A static estimate
from real prompt sizes puts one three-fact answer at roughly 2,950 router input
tokens and ~1,700 synthesis input tokens, i.e. **~$0.011 against $0.15 charged
(~93%)** — but the synthesizer runs adaptive thinking, and thinking tokens bill
as output at $10/MTok and are not estimable from prompt size. At 2,000 thinking
tokens the same call is ~$0.031 and the margin is ~79%, i.e. straddling the
PRD's assumption. The service logs an `ask.margin` line with both models' real
token counts on every call, so the first hour of live traffic settles this. It
is not settled now.

## 4e. What must run before `/ask` is enabled

Not optional, and in this order:

1. `ANTHROPIC_API_KEY` set on the service; redeploy.
2. `curl -s $BASE/health | jq '.ask'` -> `configured: true`.
3. `SMOKE_BASE_URL=$BASE SMOKE_SSH="railway ssh --service Postgres" npm run ask:smoke`
   — the four brief questions, paid. Expect exactly three new `payments` rows
   at `150000` and **none** for the forecast question.
4. Read the three prose answers. Ship only if each sentence is one an agent
   could quote to its operator without overstating the data. If not: fix the
   prompt and re-run, do not ship it.
5. Read the `ask.margin` log lines and record the measured cost here.

## 4f. Discovery surface — built and verified on the deployed service

Run 2026-09-09 against `https://api-testnet-production-a3ec.up.railway.app`
over public HTTPS. `/openapi.json`, `/methodology` and `/ask` had been merged
but never deployed; the service 404'd all three until this deploy.

### Routes, over HTTPS

| Route | Result |
|---|---|
| `GET /` | 200 `text/html` — the generated landing page |
| `GET /health` | 200, all three connectors `ok` |
| `GET /catalog` | 200, now carrying `protocols[].declined` and `routes[].available` |
| `GET /llms.txt` | 200 |
| `GET /openapi.json` | 200, `openapi: 3.1.0`, 8 paths |
| `GET /methodology` | 200 JSON; `?format=markdown` 200 `text/markdown` |
| `GET /og-banner.png` | 200 `image/png`, **1200x630**, 48,058 bytes |
| `GET /favicon.png` | 200 `image/png`, 512x512 |
| `GET /metric/tinyman/tvl` | 402 with the full requirements |
| `GET /compare` | 402 with the full requirements |
| `POST /ask` | **503 `ASK_NOT_CONFIGURED`** — and no 402 quoted |

`ask.configured: false`, `ask.methodology_document: true`. `/ask` is not
enabled: see §4d, and §4g below for why it was not enabled in this session
either.

### OpenGraph

Every tag from DEPLOYMENT.md §6.3 is present, and `og:image` is an absolute
URL that resolves — fetched from the public URL, `200 image/png`, and confirmed
1200x630 by decoding the bytes rather than by trusting the `og:image:width`
tag next to it.

### `/llms.txt` diffed against the live `/catalog`

Machine-checked, not eyeballed. For each of the three protocols: the KPI count
and the KPI list in `/llms.txt` equal `/catalog`'s exactly; **no KPI a connector
declines appears in any published list**; and every declined KPI is rendered
with its reason. Every route and price string in `/llms.txt` matches
`/catalog`'s. Result: accurate.

### Bazaar discovery blocks — and the defect the diff found

Decoding the 402 for every paid route and diffing the blocks against each other
found a real bug in `/ask`'s, which no existing test could reach because the
block is only built when the route is gated and no deployment gates it.

`declareDiscoveryExtension` picks between an HTTP query branch and an HTTP body
branch on the presence of `bodyType` alone. Ours omitted it, so `/ask`'s body
fields were published as **`queryParams`**: the block instructed an agent to
send `POST /ask?question=...&format=both`, which the handler answers 400 to.
Nothing failed on our side; the caller's first request would have failed on
theirs. Fixed with `bodyType: 'json'`, verified by booting the service with a
key present and decoding the real 402:

| Route | input shape | challenge tag | description | output example |
|---|---|---|---|---|
| `GET /metric/:protocol/:kpi` | `queryParams` | ✓ | ✓ | ✓ |
| `GET /compare` | `queryParams` | ✓ | ✓ | ✓ |
| `POST /ask` | `body(json)` | ✓ | ✓ | ✓ |

Three published examples also overstated what the route returns: `/metric`'s
`output_example`, the landing page and `/llms.txt` all read
`value: 6300000, confidence: 0.95`, where the route serves ~$5.34M at **0.70**.
0.95 was never reachable for `tvl` — it is denominated in USD, so §5's
`usd_conversion` row caps it at 0.90 x a TVL-weighted price confidence. All
three now carry measured values.

### `examples/` — from a clean clone

`git clone` to a fresh directory, `cd examples && npm install && npm start`.
Ran end to end and settled two real TestNet payments:

| Call | Amount | TxID |
|---|---|---|
| `GET /metric/tinyman/tvl` | 5000 | `JADJBZQX6RDNOTAC2HANSDCXX362NUWPMK5G5BHTQT4LNREFYMGA` |
| `GET /compare?protocols=tinyman,pact,folks&metric=capital_efficiency` | 50000 | `S6YIJK5BIHACVG4HGYXANDN2T7QYTBXZO3WFU2PBKGX6XA2PDANQ` |

`GET /metric/pact/take_rate` returned 404 `KPI_NOT_APPLICABLE` with Pact's
decline reason and **no settlement receipt** — the settle-after-success
guarantee, demonstrated to a caller rather than asserted to one.

### Smoke test: 2 of 3 runs green, and the third is the finding

`npm run testnet:smoke` was run three times against the deployed service.
Runs 1 and 3 passed every check (69 checks, exit 0, "All checks passed").

**Run 2 did not.** Its `?fresh=true` leg delivered a 200 and then failed to
settle. The ledger row is the one this schema was designed to be able to write:

```
15:12:11  settle_failed  20000  /metric/{protocol}/{kpi}
  error_reason: Transaction simulation failed: txn dead:
                round 67140101 outside of 67140052--67140062
```

The caller's signed payment group had an ~11-round validity window (~31 s). The
settle attempt came at round 67140101 — about 110 s after the window closed —
because the `?fresh=true` handler forced an upstream fetch while Tinyman's
analytics API was returning `429 Throttled`, and the retries took the handler
past two minutes. Data delivered, $0.02 not collected. See §4g.

Ledger totals at the end of the session: **20 settled (400,000 atomic), 1
settle_failed (20,000 atomic)**. `/health` reported `status: degraded` with
`settle_failures_1h: 1` — the monitor fired correctly, on a real failure, which
is the first time it has done so on anything but a synthetic one.

## 4g. Open before MainNet

The next step moves real money and makes the `payTo` address public and
permanent. These are the things worth deciding before that, in the order I
would fix them.

### 1. A slow handler can outlive the payment it was paid with — BLOCKING

Proven, not theoretical: §4f's `settle_failed` row. The caller's signed payment
group is valid for ~11 rounds (~31 s), and that window is set by the **client**
when it builds the transaction. We quote `maxTimeoutSeconds: 60`, which is
longer than the window the client actually uses — so a handler that finishes
comfortably inside our own quoted timeout can still find the payment dead.

Settle-after-success means the handler runs first. There is currently **no
deadline on the handler at all**. Whenever a paid request takes longer than the
payment lives, we deliver the data and collect nothing, and the caller keeps
its answer for free. It bites hardest exactly where it costs most: `?fresh=true`
forces an upstream fetch, is the slowest path we sell, and is priced 4x the
base route.

On TestNet it cost $0.02 and produced a log line. On MainNet it is uncapped
silent revenue loss, and it is also a leaderboard discrepancy — the data was
served but no transaction exists to show for it.

The fix is a deadline on the paid handler, set below the payment's validity
window rather than to our quoted 60 s, returning `504` (which does not settle,
and does not charge) instead of a 200 we cannot collect on. **Failing free is
strictly better than serving free**, because a 504 costs the caller nothing and
tells it to retry, while a 200 we cannot bill for is a product we are giving
away without deciding to. Consider also quoting `maxTimeoutSeconds` at the real
window rather than 60 s, so the number we advertise is the number that governs.

### 2. Tinyman's analytics API throttles us, and that is what triggered #1

`429 Throttled` on `/api/v1/pools/...` and `/api/v1/assets/...` during the
refresher's own cycle. `src/connectors/http.ts` retries with backoff and
respects `Retry-After`, which is why nothing returns wrong — but the retries are
what pushed the `?fresh=true` handler past two minutes.

This is one connector's rate limit interacting with a per-request deadline we
do not have. Worth lowering the per-host concurrency for
`mainnet.analytics.tinyman.org` and giving the fresh path a fetch budget it
cannot exceed. #1 makes the symptom safe; this makes it rare.

### 3. The refresher's fast cycle overruns its interval

`/health` has shown the 60 s cycle taking 73.9 s, and `overruns` / `skipped`
counters incrementing. It degrades correctly — it skips rather than queueing,
which is the right choice — but a cycle that regularly cannot finish inside its
interval is not really a 60 s cycle, and the skips mean the hot set is
occasionally staler than the TTL implies. Either widen the interval to what the
work actually takes or narrow the fast group. Cosmetic next to #1, but it is
the same root cause: upstream latency we do not bound.

### 4. `/ask` is still unverified against a real model

Unchanged from §4d and §4e. It ships disabled and honest — 503, no 402, marked
unavailable on `/llms.txt`, `/openapi.json`, `/catalog` and the landing page,
and absent from the OG banner. But the prose has never been read, and
`PRD.md` §5.3's ~80% margin for the route is still an estimate that straddles
its own assumption (§4d). Do not enable it on MainNet before §4e runs.

`ANTHROPIC_API_KEY` is **not** in `.railway/railway.ts`'s env list, so setting
it in the dashboard alone will survive a deploy but not a `railway config
apply`. Add it as `preserve()` when the key is set.

### 5. Payer-concentration monitoring exists as SQL, not as a job

`DEPLOYMENT.md` §7.2 and `PRD.md` §7.6 define the 40% threshold and the query,
but nothing runs it. The rule that disqualifies an entry is the one nobody is
watching automatically. A weekly job that prints §7.2's two queries — and
especially the second, "our own addresses must never appear" — costs an hour
and is the difference between noticing on day two and noticing at submission.

### 6. Confirm the MainNet `payTo` opt-in before, not after

`DEPLOYMENT.md` §2.4 is explicit and the TestNet equivalent is logged in §1,
but the MainNet account's USDC opt-in has no entry in this document yet. An
account that has not opted in cannot receive the asset and every payment to it
fails. It is a one-command check and it is the single cheapest catastrophic
mistake to rule out. Do it before the §5.1 payment, and paste the output here.

### 7. Sub-cent quota, from day one

§1.1's note: the $0.005 base route sits under the facilitator's $0.01 sub-cent
threshold, so it draws on 1,000 free settles per `payTo` per chain per month.
Past that, settles return 429 and — given #1's absence of a deadline and the
gate's treatment of a settle failure — the caller still gets its data and we
still eat the loss. Watch `X-Subcent-Quota` from the first MainNet day rather
than the day it bites.

---

## 5. MainNet verification payment

Not yet applicable — `DEPLOYMENT.md` §5 requires §4 fully green first.
