# AlgoTerminal quickstart

A runnable x402 client. Two paid calls against the AlgoTerminal TestNet
deployment, settling real TestNet USDC — which is free.

Total cost of a full run: **0.055 TestNet USDC**, and TestNet USDC comes from a
faucet. Nothing here touches MainNet or real money.

```bash
git clone https://github.com/SamyaDeb/algoterminal
cd algoterminal/examples
npm install
cp .env.example .env      # paste a funded TestNet mnemonic
npm start
```

## What you need

One TestNet account holding TestNet USDC (ASA `10458941`):

1. **ALGO for fees and the minimum balance** — https://bank.testnet.algorand.network
2. **Opt the account in to ASA 10458941.** An account that has not opted in
   cannot hold the asset, and the payment will fail.
3. **TestNet USDC** — https://faucet.circle.com, select Algorand TestNet.

Put the 25-word mnemonic in `.env` as `TESTNET_PAYER_MNEMONIC`. It signs
payments locally and is sent nowhere but your own algod node; AlgoTerminal only
ever receives, and never needs a key of yours.

## What it does

| Step | Call | Cost |
|---|---|---|
| 0 | `GET /catalog` — what is for sale, and what each protocol declines | free |
| 1 | `GET /metric/tinyman/tvl` **without paying** — reads the 402's payment requirements | free |
| 2 | `GET /metric/tinyman/tvl` — one `KpiFact` with provenance and confidence | $0.005 |
| 3 | `GET /compare?protocols=tinyman,pact,folks&metric=capital_efficiency` | $0.05 |
| 4 | `GET /metric/pact/take_rate` — a KPI Pact declines: 404, and **not charged** | free |

Steps 0, 1 and 4 are there because they are the ones worth seeing before you
integrate: you can read the whole catalogue and the exact price without paying,
and an error genuinely does not cost you anything.

## The integration, in full

Everything AlgoTerminal-specific is the URL. The client is stock `@x402/fetch`:

```js
import algosdk from 'algosdk';
import { wrapFetchWithPayment } from '@x402/fetch';
import { x402Client } from '@x402/core/client';
import { ExactAvmScheme } from '@x402/avm/exact/client';
import { toClientAvmSigner } from '@x402/avm';

const account = algosdk.mnemonicToSecretKey(process.env.TESTNET_PAYER_MNEMONIC);
const client = new x402Client().register(
  'algorand:*',
  new ExactAvmScheme(toClientAvmSigner(Buffer.from(account.sk).toString('base64')), {
    algodUrl: 'https://testnet-api.4160.nodely.dev',
  }),
);

const pay = wrapFetchWithPayment(fetch, client);

// From here on, every call is an ordinary fetch that happens to pay.
const fact = await (await pay(`${BASE}/metric/tinyman/tvl`)).json();
console.log(fact.value, fact.unit, fact.confidence);
```

`wrapFetchWithPayment` handles the 402: it reads the requirements, builds and
signs the atomic group, and retries with a `PAYMENT-SIGNATURE` header. You do
not write any of that.

## Going to MainNet

Change `ALGOTERMINAL_BASE_URL` and fund the account with real USDC (ASA
`31566704`). **No code changes** — `algorand:*` registers the scheme for both
networks, and the 402 itself names the chain, the asset and the amount.

## Two things to know before you budget

- **We settle only after a successful response.** The payment is captured after
  the handler returns 2xx. Any 4xx or 5xx costs you nothing — including a
  `?fresh=true` that could not produce a fresh number, and a comparison that
  could not resolve at least two legs. Step 4 above demonstrates this.
- **A stale number is never sold as a fresh one.** Every response carries its own
  `cache` and `stale` state, a confidence penalty when it is stale, and a note
  saying how old it is and why. When confidence falls to the 0.40 floor we
  decline rather than sell it.

## Reading a `KpiFact`

```jsonc
{
  "metric": "tvl", "protocol": "tinyman",
  "value": 6300000.0, "unit": "USD",
  "timestamp": "2026-09-09T14:32:11Z",  // when WE computed it
  "as_of":     "2026-09-09T14:30:00Z",  // the moment the data describes
  "source": [{ "name": "tinyman-analytics", "url": "...", "kind": "rest",
               "retrieved_at": "2026-09-09T14:30:02Z" }],
  "confidence": 0.95,          // 0-1; >= 0.9 is safe to act on, < 0.7 is caveated
  "is_estimated": false,
  "methodology_version": "1.2.0",
  "cache": "hit", "stale": false,
  "coverage": { "entities": 412, "excluded": 7, "basis": "all_pools_usd_priced" },
  "notes": []
}
```

`timestamp` and `as_of` are never the same field. Everything that degrades
`confidence` is named in `notes`.

Full definitions: [`/methodology`](https://api-testnet-production-a3ec.up.railway.app/methodology).
Agent-facing summary: [`/llms.txt`](https://api-testnet-production-a3ec.up.railway.app/llms.txt).
