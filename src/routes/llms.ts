import { Hono } from 'hono';

import { env } from '../config/env.js';
import {
  activeNetwork,
  FEE_SPONSORED,
  USDC_TESTNET_ASA,
  type NetworkConstants,
} from '../config/x402.js';
import { listConnectors } from '../connectors/registry.js';
import type { Connector } from '../connectors/types.js';
import { formatUsdc, freeRoutes, paidRoutes } from '../pricing.js';
import { gatedRoutes, MAX_TIMEOUT_SECONDS } from '../gate/routes.js';
import { STALE_SERVE_POLICY } from './metric.js';
import { SERVICE_NAME } from './catalog.js';
import { KPI_FACT_SCHEMA_PATH, SCHEMA_VERSION_KEY } from '../standardize/jsonschema.js';

/**
 * `GET /llms.txt` — API_SPEC.md §3.6, content per DEPLOYMENT.md §6.2. Free.
 *
 * Written for an agent deciding whether to spend money, which is why it is
 * generated rather than checked in as a static file: every price comes from
 * `src/pricing.ts` and every payment constant from `src/config/x402.ts`, the
 * same modules the gate charges from. A hand-maintained llms.txt is the most
 * likely place in the whole product for an advertised price to drift from a
 * charged one, because nothing fails when it does.
 *
 * It also carries the two purchasing considerations an agent cannot infer from
 * a price: the settle-after-success guarantee (§2.3) and what happens when our
 * cache is cold (`STALE_SERVE_POLICY`). Both are commitments about when we take
 * money, and an operator deserves them in the same document as the prices.
 */

/**
 * One protocol's real KPI matrix: what it publishes, and what it declines.
 *
 * The declines are here rather than left implicit because this document is read
 * by an agent deciding whether to spend money, and "Pact has no take_rate" and
 * "Pact does not disclose its fee split" lead to different decisions. The first
 * reads as our coverage being thin and is a reason to look elsewhere; the
 * second is a finding about Pact that our answer is the one place to get. Both
 * halves come from `capabilities()`, the same declaration `/catalog` and
 * `/metric`'s 404 read, so this cannot advertise a KPI a connector declines.
 */
function protocolLine(connector: Connector): string {
  const caps = connector.capabilities();
  const declined = Object.keys(caps.declined ?? {});
  const publishes = `- **${caps.name}** (\`${caps.id}\`, ${caps.class}) — ${caps.kpis.length} KPIs: ${caps.kpis.join(', ')}`;
  if (declined.length === 0) return publishes;
  return `${publishes}\n  - _Declines_ (404 \`KPI_NOT_APPLICABLE\` with the reason, never charged): ${declined.join(', ')}`;
}

/**
 * The free evaluation surface (PRD.md §7.5, §7.4).
 *
 * An agent must be able to evaluate us completely without paying, so that every
 * mainnet payment represents genuine demand rather than a trial. That is a
 * compliance position as much as a product one, and it is worth stating in the
 * document where the buying decision is made — an operator that does not know
 * the TestNet twin exists will either pay to find out whether we are any good,
 * or more likely will not.
 *
 * On the TestNet deployment itself there is nothing to advertise: it IS the
 * free surface, and saying so is more useful than pointing at itself.
 */
function evaluationSurface(net: NetworkConstants): string {
  if (net.network === 'testnet') {
    return (
      '\nThis deployment is the free evaluation surface: the API is identical to\n' +
      'MainNet, and the paid routes settle in TestNet USDC (ASA ' +
      `${net.usdcAsaId}), which the\n` +
      'Algorand dispenser gives away. Integrate against it, confirm the numbers are\n' +
      'worth money to you, and only then point your client at MainNet.\n'
    );
  }
  const testnet = env.TESTNET_BASE_URL;
  if (testnet === undefined) return '';
  return (
    `\nFree evaluation, end to end: ${testnet}\n` +
    'The same API on Algorand TestNet, where the paid routes settle in TestNet USDC\n' +
    `(ASA ${USDC_TESTNET_ASA}) from the free dispenser. Every route above behaves identically,\n` +
    'including the 402s and the settlement, so you can prove the integration and\n' +
    'judge the data before you spend a real cent. We would rather you did.\n'
  );
}

export function buildLlmsTxt(net: NetworkConstants = activeNetwork()): string {
  const base = env.PUBLIC_BASE_URL;
  const networkName = net.network === 'mainnet' ? 'Algorand MainNet' : 'Algorand TestNet';
  const gated = new Set(gatedRoutes().map((r) => r.path));

  const paid = paidRoutes()
    .map((route) => {
      const prices = route.variants
        .map((v) => `  - $${formatUsdc(v.amountAtomic)} — ${v.when}`)
        .join('\n');
      const status = gated.has(route.path) ? '' : ' _(not yet live)_';
      return `- \`${route.method} ${route.path}\`${status}\n${prices}`;
    })
    .join('\n');

  const free = freeRoutes()
    .map((route) => `- \`${route.method} ${route.path}\` — ${route.rationale}`)
    .join('\n');

  return `# ${SERVICE_NAME}

> Standardized financial KPIs for Algorand DeFi protocols, priced per query in
> USDC over x402. Built for autonomous agents and trading bots.

One consistent accounting policy across every protocol we cover, so a DEX and a
lending market are directly comparable. Data is computed by us from public
on-chain and public-API sources. No API key, no signup, no subscription — the
payment is the authentication.

## Payment
- Protocol: x402 v${net.x402Version}, scheme \`${net.scheme}\`
- Network: ${networkName} (\`${net.caip2}\`)
- Asset: USDC, ASA ${net.usdcAsaId} (${net.usdcDecimals} decimals)
- Facilitator: ${env.X402_FACILITATOR_URL}
- payTo: ${env.X402_PAYTO}
${FEE_SPONSORED ? '- Network fee sponsored by the facilitator — you need USDC only, no ALGO.\n' : ''}- Payment is settled only after a successful response. Errors are never charged.
- We finish within \`maxTimeoutSeconds: ${MAX_TIMEOUT_SECONDS}\`, or we return 504 and charge nothing.

### Your payment's validity window is the real clock
Settlement happens *after* we produce your answer, so the deadline that matters
is \`lastValid\` on the payment transaction **you** signed — not our timeout. An
x402 AVM client builds that group through algokit, whose default validity
window is 10 rounds: about 31 seconds at ~2.75 s/round. We read it off your
payment and hold the request open only for as long as it is still settleable,
minus the settle round-trip.

If we run out of that window we return **504 \`PAYMENT_WINDOW_EXPIRED\`**. Nothing
is settled and nothing is charged — you keep your USDC and we keep the data.
That is deliberate: serving you data we can no longer collect on would be a
free tier we never decided to offer.

What this means in practice:
- Cached reads finish in milliseconds. The window is never a factor.
- \`?fresh=true\` forces an upstream fetch and is the one path that can approach
  it. It is also the path where a 504 costs you nothing, so retrying is safe.
- Want more room? Build your payment with a longer validity window. We will use
  what you give us, up to ${MAX_TIMEOUT_SECONDS} seconds.

## Free endpoints (no payment)
${free}
${evaluationSurface(net)}

## Paid endpoints
${paid}

## What you are buying when our cache is cold
${STALE_SERVE_POLICY}

Every response says which of these you got, in the body and in a header:

- \`cache: "hit"\`, \`stale: false\` — computed within this KPI's TTL.
- \`cache: "miss"\`, \`stale: false\` — computed for you, just now.
- \`cache: "stale"\`, \`stale: true\` — a previously computed number served past
  its TTL, or the last-known-good snapshot, while a refresh runs. \`confidence\`
  carries the penalty for it and \`notes\` says how old it is and why.

Charged: a labelled stale answer. It is a real number, correctly described.
Not charged: any 4xx or 5xx, including \`UPSTREAM_UNAVAILABLE\` when every tier is
exhausted, and any answer whose confidence has fallen to the 0.40 floor — at
that point we can no longer bound the error, so we decline instead of selling it.
Not charged: \`?fresh=true\` that could not produce a fresh number. Recency is
what that tier is for; if we cannot deliver it, the request was not fulfilled.

## Response shape
Every \`/metric\` response is one \`KpiFact\`:

\`\`\`json
{
  "metric": "tvl", "protocol": "tinyman", "value": 5344337.0, "unit": "USD",
  "timestamp": "2026-09-08T14:32:11Z", "as_of": "2026-09-08T14:30:00Z",
  "source": [{ "name": "tinyman-analytics", "url": "...", "kind": "rest",
               "retrieved_at": "2026-09-08T14:30:02Z" }],
  "confidence": 0.70, "is_estimated": false, "estimation_method": null,
  "methodology_version": "${env.METHODOLOGY_VERSION}",
  "cache": "hit", "stale": false,
  "coverage": { "entities": 412, "excluded": 7, "basis": "all_pools_usd_priced" },
  "notes": ["..."]
}
\`\`\`

\`timestamp\` is when we computed; \`as_of\` is the moment the data describes.
They are never the same field.

**The envelope has a machine-readable contract.** \`${base}${KPI_FACT_SCHEMA_PATH}\`
is that object as JSON Schema (draft 2020-12), free and stamped
\`${SCHEMA_VERSION_KEY}: "${env.METHODOLOGY_VERSION}"\`. Generate types from it in
your language, or validate what you received before you act on it — including
the rules that are not obvious from the example above: a \`value\` may be
\`null\` only alongside an \`error\`, an \`is_estimated: true\` fact always carries
a non-empty \`estimation_method\`, and a RATIO is a decimal fraction rather than
a percentage. It is a contract, not a client library: we publish what a
response IS, and leave fetching it to your stock x402 client.
See \`${base}/methodology\` §7 for what a version bump is allowed to change.

Those are real values from this route, not illustrative ones. Note the 0.70:
\`tvl\` is denominated in USD, so it is capped by the price confidence of the
assets in the pools, and \`notes\` says exactly which step cost what. A KPI read
straight off the chain scores higher.

## Comparing protocols, and when a comparison is not one
\`GET /compare?protocols=a,b,c&metric=x\` returns the same KPI across 2-5
protocols with the ranking, the spread and a generated statement of what makes
them comparable. It is composed from the same cached facts \`/metric\` serves, is
never cached as a unit, and reports the worst cache state across its legs.

- **Every leg appears in \`facts[]\`**, including the ones that failed, as an
  error fact with a reason. One bad protocol never fails the whole call.
- **2 or more legs resolve** -> \`200\` with \`partial: true\` and
  \`excluded_protocols\`. Charged: you got a usable comparison.
- **Fewer than 2 resolve** -> \`502 INSUFFICIENT_DATA\`. **Not charged.** A
  one-way "comparison" is not the product, and charging for a non-answer is the
  thing that stops an agent calling twice.
- **The metric applies to none of the protocols you named** -> \`422
  KPI_NOT_APPLICABLE_TO_ANY\`. **Not charged.** Nothing was computed and nothing
  could have been.
- \`comparability.confidence\` is the **MINIMUM** across legs, never the mean. A
  comparison is only as trustworthy as its weakest side.
- \`ranking\` is strictly descending by value for every KPI, and says so in
  \`ranking_basis\`. Rank 1 is the largest number, not the "best" one — some of
  these are arguably better low, and which is better depends on which side of
  the trade you are on. We do not take that position for you.
- \`spread.ratio\` is \`null\`, never \`Infinity\` or \`NaN\`, whenever the lowest
  value is zero or negative and the quotient would not be a real multiple.
  \`spread.max\` and \`spread.min\` are always the measured values.
- \`comparability.caveats\` is generated per response and is empty when nothing
  warrants one. When it is not empty it is the part worth reading: it names
  legs measured on a different \`coverage.basis\`, legs that are estimates, legs
  below the 0.7 confidence line, and — when the legs span protocol types — why
  a DEX and a lending market belong on this axis at all.

## Asking a question instead of naming a metric
\`POST /ask\` takes a natural-language question and answers it strictly from the
same facts \`/metric\` sells. It is descriptive only.

\`\`\`json
{ "question": "Which Algorand DeFi protocol generates the most fee revenue per dollar of TVL?",
  "format": "both", "max_facts": 12 }
\`\`\`

- **\`facts[]\` is always returned**, including under \`format: "prose"\`. Every
  number in the prose corresponds to a fact in that array, and that is enforced
  by a check on our side, not just requested in a prompt: an answer containing a
  number we cannot point at is never returned. The prose is a convenience over
  the data, never a substitute for it — read the numbers and ignore the
  narrative if you prefer.
- **\`citations[]\`** maps each claim to the index of the fact it rests on.
- **No forecasts, no price targets, no trading advice.** A question asking for
  one returns \`422 OUT_OF_SCOPE\`. **Not charged.**
- **A question we cannot map onto our coverage** returns \`422
  UNROUTABLE_QUESTION\` with the list of protocols and KPIs we do publish.
  **Not charged.** Probe freely: the routing step is cheap and we eat it rather
  than charge for a non-answer.
- **Routed but nothing resolved, or an answer that failed our own grounding
  checks**, returns \`502 INSUFFICIENT_DATA\`. **Not charged.**
- Any fact below the 0.7 confidence line is explicitly caveated in the prose and
  in \`caveats[]\`.
- A KPI a protocol declines to publish is stated, never omitted. Ask "which
  protocol has the highest take rate" and the answer says that Pact does not
  publish its fee split — it does not quietly rank the other two.
- \`?depth=deep\` is a query parameter, not a body field, because it is priced
  and the price is quoted before the body is read.

## Coverage
${listConnectors().map(protocolLine).join('\n')}

A declined KPI is not a gap in our coverage — it is a fact about the source, and
we return it as one. \`GET /metric/pact/take_rate\` answers 404
\`KPI_NOT_APPLICABLE\` with a paragraph explaining that Pact's own \`pact_fee_bps\`
is null on all 3,961 of its pools, so the only honest bound on its protocol
revenue is "at least \$0". We could publish \$0.00 and rank Pact last; that would
be a statement about disclosure wearing the clothes of a statement about
economics. Every decline is readable for free at \`/catalog\`, under
\`protocols[].declined\`, before you spend anything.

Live capability list, generated from the connectors themselves: ${base}/catalog

## Example
\`\`\`bash
# 1. Learn the price (free)
curl -s ${base}/catalog | jq '.routes'

# 2. Ask without paying — the 402 tells you what it costs, in a header and a body
curl -si ${base}/metric/tinyman/tvl

# 3. Pay and read, with any x402 client
#    npm i @x402/fetch @x402/avm
\`\`\`

## What we do not do
- We do not return a plausible-looking zero. A number we cannot compute is
  \`null\` with a reason, or an error — never a 0 that looks like an answer.
- We do not serve a stale number as a fresh one. Freshness is in the response,
  not only in our logs.
- We do not change a formula silently. A formula change is a
  \`methodology_version\` bump, published at ${base}/methodology.
`;
}

export const llms = new Hono();

llms.get('/llms.txt', (c) => c.text(buildLlmsTxt()));
