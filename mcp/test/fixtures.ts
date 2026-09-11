/**
 * Fixtures taken from the live TestNet deployment, not invented.
 *
 * The catalog below is the real `GET /catalog` response with the decline
 * paragraphs kept in full — they are the thing several tests assert survives
 * the round trip to the model, so a shortened version would test nothing. The
 * KpiFact is the example the service itself publishes at `/llms.txt`, including
 * its 0.70 confidence, which is a real score for a USD-denominated KPI and the
 * reason the confidence-banner tests have a realistic middle case to work with.
 */
import type { Catalog, CompareResponse, KpiFact } from '../src/types.js';

export const PACT_TAKE_RATE_DECLINE =
  'take_rate is protocol_revenue_24h / gross_fees_24h, and Pact does not publish the numerator: ' +
  '`pact_fee_bps` is null on all 3,961 pools. A take_rate of 0.000000 would rank Pact below every protocol ' +
  'that discloses its cut, for a reason that is about disclosure rather than economics (DATA_SCHEMA.md §1.5, §3.4).';

export const CATALOG: Catalog = {
  service: 'AlgoTerminal',
  methodology_version: '1.2.0',
  network: 'algorand-testnet',
  payment: {
    protocol: 'x402',
    version: 2,
    scheme: 'exact',
    asset: '10458941',
    asset_symbol: 'USDC',
    decimals: 6,
    network: 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=',
    facilitator: 'https://facilitator.goplausible.xyz',
    payTo: 'BKRGZZ32PRF6XV7PFJAFM47MF37FPWG6YTT5ONM3OJEUE2HUYZHBZA55UQ',
    fee_sponsored: true,
  },
  protocols: [
    {
      id: 'folks',
      name: 'Folks Finance',
      class: 'lending',
      kpis: [
        'tvl',
        'total_borrows',
        'utilization',
        'supply_apr',
        'borrow_apr',
        'gross_fees_24h',
        'supply_side_revenue_24h',
        'protocol_revenue_24h',
        'take_rate',
        'capital_efficiency',
        'active_users_24h',
        'pool_count',
      ],
      sources: ['algod:mainnet-api.4160.nodely.dev', 'mainnet-idx.4160.nodely.dev'],
    },
    {
      id: 'pact',
      name: 'Pact',
      class: 'dex',
      kpis: ['tvl', 'volume_24h', 'gross_fees_24h', 'capital_efficiency', 'volume_to_tvl', 'pool_count'],
      sources: ['api.pact.fi'],
      declined: {
        take_rate: PACT_TAKE_RATE_DECLINE,
        protocol_revenue_24h:
          "Pact does not publish the protocol's share of the swap fee. `pact_fee_bps` is null on every pool " +
          'in the catalogue (3,961 of 3,961, measured 2026-09-09), so the only honest bound is "at least $0", ' +
          'which constrains nothing.',
        supply_side_revenue_24h: 'Derived from a fee split Pact does not publish.',
        fee_apr: 'fee_apr is supply_side_revenue_24h * 365 / tvl, and the supply-side split is unpublished.',
        active_users_24h: 'Pact has no single validator application to filter on: every pool is its own application.',
      },
    },
    {
      id: 'tinyman',
      name: 'Tinyman',
      class: 'dex',
      kpis: [
        'tvl',
        'volume_24h',
        'gross_fees_24h',
        'supply_side_revenue_24h',
        'protocol_revenue_24h',
        'take_rate',
        'capital_efficiency',
        'fee_apr',
        'volume_to_tvl',
        'active_users_24h',
        'pool_count',
      ],
      sources: ['mainnet.analytics.tinyman.org'],
    },
  ],
  routes: [
    {
      path: '/metric/{protocol}/{kpi}',
      method: 'GET',
      price_usdc: '0.005',
      price_fresh_usdc: '0.02',
      price_active_users_usdc: '0.03',
      available: true,
    },
    { path: '/compare', method: 'GET', price_usdc: '0.05', price_fresh_usdc: '0.08', available: true },
    { path: '/ask', method: 'POST', price_usdc: '0.15', price_deep_usdc: '0.2', available: false },
  ],
};

/** The catalog as it will look once /ask is live. */
export const CATALOG_WITH_ASK: Catalog = {
  ...CATALOG,
  routes: CATALOG.routes.map((r) => (r.path === '/ask' ? { ...r, available: true } : r)),
};

export const TVL_NOTE =
  'tvl is denominated in USD, so it is capped by the price confidence of the assets in the pools (0.74 ' +
  'TVL-weighted); 7 of 419 pools were excluded for lacking a USD-priceable leg.';

/** The example the service publishes at /llms.txt, verbatim. */
export const TINYMAN_TVL: KpiFact = {
  metric: 'tvl',
  protocol: 'tinyman',
  value: 5344337.0,
  unit: 'USD',
  timestamp: '2026-09-08T14:32:11Z',
  as_of: '2026-09-08T14:30:00Z',
  source: [
    { name: 'tinyman-analytics', url: 'https://mainnet.analytics.tinyman.org', kind: 'rest', retrieved_at: '2026-09-08T14:30:02Z' },
  ],
  confidence: 0.7,
  is_estimated: false,
  estimation_method: null,
  methodology_version: '1.2.0',
  cache: 'hit',
  stale: false,
  coverage: { entities: 412, excluded: 7, basis: 'all_pools_usd_priced' },
  notes: [TVL_NOTE],
};

export const CROSS_CLASS_CAVEAT =
  'These legs span two protocol classes. §3.1 defines gross_fees identically for both — swap fees paid by ' +
  'traders and interest paid by borrowers are both what users pay to use the protocol — so the ratio is ' +
  'constructed the same way on each side and the comparison is a real one.';

export const BASIS_CAVEAT =
  'folks is measured on coverage.basis "total_deposits" while tinyman is on "all_pools_usd_priced". Those ' +
  'are different populations; read a difference between them accordingly.';

export const COMPARISON: CompareResponse = {
  metric: 'capital_efficiency',
  unit: 'RATIO',
  timestamp: '2026-09-09T16:40:00Z',
  methodology_version: '1.2.0',
  facts: [
    {
      metric: 'capital_efficiency',
      protocol: 'tinyman',
      value: 0.0369,
      unit: 'RATIO',
      timestamp: '2026-09-09T16:39:00Z',
      as_of: '2026-09-09T16:30:00Z',
      confidence: 0.7,
      is_estimated: false,
      methodology_version: '1.2.0',
      cache: 'hit',
      stale: false,
      coverage: { entities: 412, excluded: 7, basis: 'all_pools_usd_priced' },
      notes: ['Built on gross fees measured from swap events.'],
    },
    {
      metric: 'capital_efficiency',
      protocol: 'folks',
      value: 0.0122,
      unit: 'RATIO',
      timestamp: '2026-09-09T16:39:00Z',
      as_of: '2026-09-09T16:30:00Z',
      confidence: 0.62,
      is_estimated: true,
      estimation_method: 'reserve-factor fallback constant',
      methodology_version: '1.2.0',
      cache: 'stale',
      stale: true,
      coverage: { entities: 18, excluded: 0, basis: 'total_deposits' },
      notes: ['Served 22 minutes past its TTL while a refresh runs.'],
    },
  ],
  ranking: [
    { rank: 1, protocol: 'tinyman', value: 0.0369 },
    { rank: 2, protocol: 'folks', value: 0.0122 },
  ],
  ranking_basis: 'strictly descending by value',
  spread: { max: 0.0369, min: 0.0122, ratio: 3.02 },
  comparability: {
    confidence: 0.62,
    note: 'The MINIMUM across legs.',
    caveats: [CROSS_CLASS_CAVEAT, BASIS_CAVEAT],
  },
  cache: 'stale',
  stale: true,
  partial: false,
  excluded_protocols: [],
};
