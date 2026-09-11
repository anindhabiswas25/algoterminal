import { Hono } from 'hono';

import { env } from '../config/env.js';
import { activeNetwork, FEE_SPONSORED, type NetworkConstants } from '../config/x402.js';
import { listConnectors } from '../connectors/registry.js';
import type { Connector } from '../connectors/types.js';
import { formatUsdc, freeRoutes, paidRoutes } from '../pricing.js';
import { gatedRoutes } from '../gate/routes.js';
import { SERVICE_NAME } from './catalog.js';

/**
 * `GET /` — the landing page (DEPLOYMENT.md §6.3). Free.
 *
 * ## Why this is generated rather than a file in `public/`
 *
 * It was a file, and the file is why this module exists. A landing page is the
 * one document in the product with no test, no consumer that fails loudly, and
 * a price table — so it is the single most likely place for an advertised price
 * to drift from a charged one, and nothing whatsoever happens when it does
 * except that an agent operator budgets against a number we do not honour.
 * Every figure below comes from `src/pricing.ts` and `src/config/x402.ts`, the
 * same modules the payment gate quotes and charges from, for exactly the reason
 * `/catalog` and `/llms.txt` do (ARCHITECTURE.md §4.1).
 *
 * `public/` still exists and is still served, for the two things that genuinely
 * are static bytes: `og-banner.png` and `favicon.png`.
 *
 * ## Crawler-first
 *
 * DEPLOYMENT.md §6.3: the first reader is the Bazaar enrichment engine, the
 * second is an agent's operator deciding in thirty seconds whether to
 * integrate, and the human browsing for pleasure is a distant third. So: the
 * content is in the markup rather than assembled by script, the order is
 * what-it-is / price / a curl you can paste / the response schema / where the
 * methodology is, there is no marketing copy above the fold, and the whole page
 * is one request with no external stylesheet, font or image to block it.
 */

const OG_DESCRIPTION =
  'Standardized financial KPIs for Algorand DeFi, priced per query in USDC over x402. Built for autonomous agents.';

const META_DESCRIPTION =
  'Agent-native financial data layer for Algorand DeFi. Standardized TVL, fees, revenue, and comparable ratios across Tinyman, Pact, and Folks Finance. Paid per query in USDC via x402.';

/** Minimal HTML-escaping for the values we interpolate (ids, prices, prose). */
export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One protocol's row: what it publishes and what it declines.
 *
 * The declines are on the landing page for the same reason they are in
 * `/llms.txt` — "no take rate for Pact" and "Pact does not disclose its fee
 * split" are different products, and only one of them is worth paying for.
 */
function protocolRow(connector: Connector): string {
  const caps = connector.capabilities();
  const declined = Object.keys(caps.declined ?? {});
  const declines =
    declined.length === 0
      ? '<span class="none">—</span>'
      : `<code>${declined.map(esc).join('</code> <code>')}</code>`;
  return `<tr>
  <th scope="row"><code>${esc(caps.id)}</code><br><span class="sub">${esc(caps.name)} · ${esc(caps.class)}</span></th>
  <td>${caps.kpis.map((k) => `<code>${esc(k)}</code>`).join(' ')}</td>
  <td>${declines}</td>
</tr>`;
}

/** Every priced variant of every paid route, as one flat table. */
function priceRows(gated: ReadonlySet<string>): string {
  return paidRoutes()
    .flatMap((route) =>
      route.variants.map((variant, i) => {
        const live = gated.has(route.path);
        const endpoint =
          i === 0
            ? `<code>${esc(route.method)} ${esc(route.path)}</code>${live ? '' : ' <span class="off">not yet live</span>'}`
            : '';
        return `<tr${live ? '' : ' class="dim"'}>
  <td>${endpoint}</td>
  <td class="num">$${esc(formatUsdc(variant.amountAtomic))}</td>
  <td>${esc(variant.when)}</td>
</tr>`;
      }),
    )
    .join('\n');
}

function freeRows(): string {
  return freeRoutes()
    .map(
      (route) =>
        `<tr>
  <td><a href="${esc(route.path)}"><code>${esc(route.method)} ${esc(route.path)}</code></a></td>
  <td class="num">free</td>
  <td>${esc(route.rationale)}</td>
</tr>`,
    )
    .join('\n');
}

/**
 * The TestNet twin, or — on the TestNet twin — the fact that you are on it.
 * PRD.md §7.5: a caller must be able to evaluate us completely without paying.
 */
function evaluationBlock(net: NetworkConstants): string {
  if (net.network === 'testnet') {
    return `<p><strong>This is the TestNet deployment</strong> — the free evaluation surface. The API is
identical to MainNet and the paid routes settle in TestNet USDC (ASA
<code>${net.usdcAsaId}</code>), which the Algorand dispenser gives away. Integrate here, decide
whether the numbers are worth money, and only then point a client at MainNet.</p>`;
  }
  const testnet = env.TESTNET_BASE_URL;
  if (testnet === undefined) return '';
  return `<p><strong>Evaluate for free first:</strong> <a href="${esc(testnet)}"><code>${esc(testnet)}</code></a>
is the same API on Algorand TestNet, settling in TestNet USDC from the free dispenser.
Every route behaves identically, 402s and settlement included, so you can prove the
integration and judge the data before spending a real cent. We would rather you did.</p>`;
}

export function buildLandingPage(net: NetworkConstants = activeNetwork()): string {
  const base = env.PUBLIC_BASE_URL;
  const gated = new Set(gatedRoutes().map((r) => r.path));
  const networkName = net.network === 'mainnet' ? 'Algorand MainNet' : 'Algorand TestNet';
  const protocolCount = listConnectors().length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${SERVICE_NAME} — Standardized Algorand DeFi KPIs, priced per query in USDC</title>
<meta name="description" content="${esc(META_DESCRIPTION)}">
<link rel="canonical" href="${esc(base)}/">
<meta property="og:title" content="${SERVICE_NAME}">
<meta property="og:description" content="${esc(OG_DESCRIPTION)}">
<meta property="og:image" content="${esc(base)}/og-banner.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${esc(base)}/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SERVICE_NAME}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${SERVICE_NAME}">
<meta name="twitter:description" content="${esc(OG_DESCRIPTION)}">
<meta name="twitter:image" content="${esc(base)}/og-banner.png">
<link rel="icon" href="/favicon.png" type="image/png">
<link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt">
<style>
:root{color-scheme:light dark;--fg:#16181d;--sub:#5a6070;--bg:#fbfbfc;--card:#fff;--line:#e2e5ea;--code:#f1f3f6;--accent:#0b6b52}
@media (prefers-color-scheme:dark){:root{--fg:#e8eaee;--sub:#9aa2b1;--bg:#0e1013;--card:#15181d;--line:#262b33;--code:#1b1f26;--accent:#5ad7ab}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:60rem;margin:0 auto;padding:2.5rem 1.25rem 4rem}
h1{font-size:1.5rem;margin:0 0 .35rem;letter-spacing:-.01em}
h2{font-size:1.05rem;margin:2.5rem 0 .75rem;letter-spacing:-.005em}
p{margin:0 0 .9rem;max-width:44rem}
.lede{font-size:1.05rem;color:var(--fg)}
.sub{color:var(--sub);font-size:.85em}
a{color:var(--accent)}
code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);padding:.1em .35em;border-radius:4px}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:1rem;overflow-x:auto;margin:0 0 1rem}
pre code{background:none;padding:0;font-size:12.5px;line-height:1.65}
.tw{overflow-x:auto;margin:0 0 1rem}
table{border-collapse:collapse;width:100%;min-width:34rem;background:var(--card);border:1px solid var(--line);border-radius:8px}
th,td{text-align:left;padding:.55rem .8rem;border-bottom:1px solid var(--line);vertical-align:top}
tbody tr:last-child th,tbody tr:last-child td{border-bottom:0}
thead th{font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;color:var(--sub);font-weight:600}
th[scope=row]{font-weight:600;white-space:nowrap}
.num{white-space:nowrap;font-variant-numeric:tabular-nums;font-weight:600}
.dim{color:var(--sub)}
.off{font-size:.75rem;color:var(--sub);border:1px solid var(--line);border-radius:99px;padding:.05em .5em;white-space:nowrap}
.none{color:var(--sub)}
footer{margin-top:3rem;padding-top:1.25rem;border-top:1px solid var(--line);color:var(--sub);font-size:.85rem}
</style>
</head>
<body>
<main>

<h1>${SERVICE_NAME}</h1>
<p class="lede">Standardized financial KPIs for ${protocolCount} Algorand DeFi protocols — TVL, fees,
revenue, take rate, capital efficiency — computed under one accounting policy so a DEX and a
lending market are directly comparable, and sold per query in USDC over x402. No API key,
no signup: the payment is the authentication.</p>

<h2>Price</h2>
<div class="tw"><table>
<thead><tr><th>Endpoint</th><th>Price</th><th>When</th></tr></thead>
<tbody>
${priceRows(gated)}
</tbody>
</table></div>

<p>Paid in USDC (ASA <code>${net.usdcAsaId}</code>, ${net.usdcDecimals} decimals) on ${networkName}, scheme
<code>${esc(net.scheme)}</code>, x402 v${net.x402Version}, settled through
<a href="${esc(env.X402_FACILITATOR_URL)}">${esc(env.X402_FACILITATOR_URL)}</a>.${
    FEE_SPONSORED
      ? ' The network fee is sponsored by the facilitator, so you need USDC only — no ALGO.'
      : ''
  }</p>

<p><strong>Two guarantees worth reading before you integrate.</strong>
<strong>We settle only after a successful response</strong> — the payment is captured after the
handler returns 2xx, so any 4xx or 5xx costs you nothing, and that includes a
<code>?fresh=true</code> that could not produce a fresh number and a comparison that could not
resolve two legs. And <strong>a stale number is never sold as a fresh one</strong>: every response
carries its own <code>cache</code> and <code>stale</code> state, a confidence penalty when it is
stale, and a note saying how old it is. When confidence falls to the 0.40 floor we decline
rather than sell it, because at that point we can no longer bound the error.</p>

<h2>Free — evaluate without paying</h2>
<div class="tw"><table>
<thead><tr><th>Endpoint</th><th>Price</th><th>Why it is free</th></tr></thead>
<tbody>
${freeRows()}
</tbody>
</table></div>
${evaluationBlock(net)}

<h2>Call it</h2>
<pre><code># 1. What we sell, and for how much — free, no payment
curl -s ${esc(base)}/catalog | jq '.protocols[].id, .routes'

# 2. Ask without paying: the 402 carries the full payment requirements
curl -si ${esc(base)}/metric/tinyman/tvl

# 3. Pay and read, with any x402 client
npm i @x402/fetch @x402/avm algosdk
</code></pre>

<pre><code>import algosdk from 'algosdk';
import { wrapFetchWithPayment } from '@x402/fetch';
import { x402Client } from '@x402/core/client';
import { ExactAvmScheme } from '@x402/avm/exact/client';
import { toClientAvmSigner } from '@x402/avm';

const account = algosdk.mnemonicToSecretKey(process.env.PAYER_MNEMONIC);
const signer = toClientAvmSigner(Buffer.from(account.sk).toString('base64'));
const client = new x402Client().register(
  'algorand:*',
  new ExactAvmScheme(signer, { algodUrl: '${esc(net.algodUrl)}' }),
);

const pay = wrapFetchWithPayment(fetch, client);
const fact = await (await pay('${esc(base)}/metric/tinyman/tvl')).json();
console.log(fact.value, fact.unit, fact.confidence);
</code></pre>

<p>A complete runnable example, funded with free TestNet USDC, is in
<a href="https://github.com/SamyaDeb/algoterminal/tree/main/examples"><code>examples/</code></a>.</p>

<h2>What you get back</h2>
<p>Every <code>/metric</code> response is one <code>KpiFact</code>. <code>timestamp</code> is when we
computed it; <code>as_of</code> is the moment the data describes. They are never the same field.</p>
<pre><code>{
  "metric": "tvl",
  "protocol": "tinyman",
  "value": 5344337.0,
  "unit": "USD",
  "timestamp": "2026-09-09T14:32:11Z",
  "as_of": "2026-09-09T14:30:00Z",
  "source": [{ "name": "tinyman-analytics", "url": "...", "kind": "rest",
               "retrieved_at": "2026-09-09T14:30:02Z" }],
  "confidence": 0.70,
  "is_estimated": false,
  "estimation_method": null,
  "methodology_version": "${esc(env.METHODOLOGY_VERSION)}",
  "cache": "hit",
  "stale": false,
  "coverage": { "entities": 412, "excluded": 7, "basis": "all_pools_usd_priced" },
  "notes": []
}
</code></pre>
<p><code>confidence</code> is 0-1 and every input that degrades it is named in
<code>notes</code>. At or above 0.9 the number is safe to act on; below 0.7 it is caveated
explicitly. Estimates are always labelled, and a number we cannot compute is
<code>null</code> with a reason or an error — never a zero that looks like an answer.</p>

<h2>Coverage</h2>
<div class="tw"><table>
<thead><tr><th>Protocol</th><th>Publishes</th><th>Declines, with the reason at <code>/catalog</code></th></tr></thead>
<tbody>
${listConnectors().map(protocolRow).join('\n')}
</tbody>
</table></div>
<p>A declined KPI is a fact about the source, not a gap in our coverage, and we return it as
one: <code>GET /metric/pact/take_rate</code> answers 404 with a paragraph explaining that Pact's
<code>pact_fee_bps</code> is null on all 3,961 of its pools, so the only honest bound on its
protocol revenue is "at least $0". Publishing $0.00 would rank Pact last for a reason that is
about disclosure rather than economics. That call is free, like every error.</p>

<h2>Methodology</h2>
<p>Every KPI has one published definition, and a formula never changes silently — a change is a
<code>methodology_version</code> bump, currently <code>${esc(env.METHODOLOGY_VERSION)}</code>, carried
in every response so you can pin to an accounting policy.
Read it at <a href="/methodology">/methodology</a>
(<a href="/methodology?format=markdown">markdown</a>), the machine-readable spec at
<a href="/openapi.json">/openapi.json</a>, and the agent-facing summary at
<a href="/llms.txt">/llms.txt</a>.</p>

<h2>What we do not do</h2>
<p>No forecasts, no price targets, no trading advice, no custody, no execution. Descriptive
standardized data only. A question asking us to predict something is refused, and not charged.</p>

<footer>
<p>${SERVICE_NAME} · ${networkName} · methodology ${esc(env.METHODOLOGY_VERSION)} ·
payTo <code>${esc(env.X402_PAYTO)}</code></p>
</footer>

</main>
</body>
</html>
`;
}

export const landing = new Hono();

landing.get('/', (c) => c.html(buildLandingPage()));
