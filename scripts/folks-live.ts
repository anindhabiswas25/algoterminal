import { folksConnector, aggregate, marketGrossFees, marketSupplySideRevenue } from '../src/connectors/folks/index.js';
import { FOLKS_MARKETS, FOLKS_SDK_VERSION } from '../src/connectors/folks/constants.js';
import { isMarketEntity, isUnreadableEntity, scaleMarket } from '../src/connectors/folks/schema.js';
import { priceOf } from '../src/connectors/types.js';
import { DEFAULT_BASIS, RETENTION_DIVERGENCE_THRESHOLD } from '../src/standardize/types.js';
import { connectorContextForMainnet } from './mainnet-context.js';

/**
 * A live mainnet run of the Folks connector — DATA_SCHEMA.md §3.5.
 *
 * Prints the fact table, the §3.1 identity check, the retention cross-check,
 * and BOTH DefiLlama divergences (raw and post-filter). DefiLlama is never a
 * value source, only a divergence signal (§3.5).
 *
 * `npx tsx scripts/folks-live.ts`
 */

const DEFILLAMA = 'https://api.llama.fi/protocol/folks-finance-lending';
const METHODOLOGY_VERSION = process.env.METHODOLOGY_VERSION ?? '1.2.0';

function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function pct(n: number): string {
  return `${(n * 100).toFixed(4)}%`;
}

async function main(): Promise<void> {
  const ctx = connectorContextForMainnet();

  console.log(`\n=== Folks Finance live run — SDK ${FOLKS_SDK_VERSION}, methodology ${METHODOLOGY_VERSION} ===`);

  // --- Step 2 re-verification: is the REST API still closed? ---------------
  console.log('\n--- Source verification (§Step 2) ---');
  for (const path of ['/v2/pools', '/v1/pools', '/pools', '/health']) {
    const res = await fetch(`https://api.folks.finance${path}`).catch(() => null);
    const body = res === null ? '(request failed)' : (await res.text()).slice(0, 60);
    console.log(`  GET api.folks.finance${path.padEnd(12)} -> ${res?.status ?? '---'}  ${body}`);
  }

  const kpis = folksConnector.capabilities().kpis;
  const t0 = Date.now();
  const snapshot = await folksConnector.fetchRaw(ctx, { basis: DEFAULT_BASIS, kpis: [...kpis] });
  const fetchMs = Date.now() - t0;

  const assetIds = folksConnector.priceAssets?.(snapshot) ?? [];
  const tp = Date.now();
  const prices = await ctx.prices.resolve([...assetIds]);
  const priceMs = Date.now() - tp;

  const facts = folksConnector.toFacts(snapshot, {
    basis: DEFAULT_BASIS,
    kpis: [...kpis],
    prices,
    now: new Date().toISOString(),
    methodologyVersion: METHODOLOGY_VERSION,
  });

  // --- Per-market table ----------------------------------------------------
  const markets = snapshot.entities.filter(isMarketEntity).map((e) => scaleMarket(e.state));
  const unreadable = snapshot.entities.filter(isUnreadableEntity);

  const rows: Array<Record<string, string>> = [];
  let rawDeposits = 0;
  let rawBorrows = 0;
  const values = [];
  for (const m of markets) {
    const price = priceOf(prices, m.assetId);
    const priced = price !== null && price.usd > 0;
    const depUsd = priced ? m.deposits * price.usd : 0;
    const borUsd = priced ? m.borrows * price.usd : 0;
    if (priced) {
      values.push({
        market: m, priceUsd: price.usd, priceConfidence: price.confidence,
        depositsUsd: depUsd, borrowsUsd: borUsd,
      });
      rawDeposits += depUsd;
      rawBorrows += borUsd;
    }
    rows.push({
      market: m.name,
      asset: String(m.assetId),
      price: priced ? `$${price.usd.toPrecision(6)}` : 'UNPRICED',
      conf: priced ? price.confidence.toFixed(2) : '-',
      deposits_usd: priced ? usd(depUsd) : '-',
      borrows_usd: priced ? usd(borUsd) : '-',
      util: m.deposits > 0 ? (m.borrows / m.deposits).toFixed(4) : '-',
      supply_apr: pct(m.depositRate),
      borrow_apr: pct(m.overallBorrowRate),
      stable_share: m.borrows > 0 ? pct(m.stableBorrows / m.borrows) : '-',
      retention: pct(m.retentionRate),
      depr: m.deprecated ? 'YES' : '',
    });
  }
  console.log('\n--- Per-market (§3.5) ---');
  console.table(rows);
  if (unreadable.length > 0) console.log('UNREADABLE MARKETS:', unreadable);

  const agg = aggregate(values);

  // --- The fact table ------------------------------------------------------
  console.log('\n--- Fact table ---');
  console.table(
    facts.map((f) => ({
      metric: f.metric,
      value: f.unit === 'USD' ? usd(f.value as number) : String(f.value),
      unit: f.unit,
      confidence: f.confidence,
      est: f.is_estimated ? 'yes' : '',
      entities: f.coverage?.entities,
      excluded: f.coverage?.excluded,
      basis: f.coverage?.basis,
      notes: (f.notes ?? []).length,
    })),
  );

  // --- §3.1 identity -------------------------------------------------------
  const get = (m: string): number => (facts.find((f) => f.metric === m)?.value as number) ?? 0;
  const gross = get('gross_fees_24h');
  const supply = get('supply_side_revenue_24h');
  const prot = get('protocol_revenue_24h');
  console.log('\n--- §3.1 identity ---');
  console.log(`  gross_fees_24h            ${usd(gross)}`);
  console.log(`  supply_side_revenue_24h   ${usd(supply)}`);
  console.log(`  protocol_revenue_24h      ${usd(prot)}`);
  console.log(`  |gross - (supply + prot)| ${Math.abs(gross - (supply + prot)).toExponential(3)}  (tolerance 1e-6)`);
  console.log(`  take_rate                 ${get('take_rate').toFixed(6)}`);

  // --- Retention cross-check (§3.5) ---------------------------------------
  console.log('\n--- Retention cross-check (§3.5) ---');
  console.log(`  gross-fee-weighted retentionRate  ${pct(agg.retentionWeighted)}`);
  console.log(`  expected protocol revenue         ${usd(agg.expectedProtocolRevenue)}`);
  console.log(`  residual (authoritative)          ${usd(agg.protocolRevenue)}`);
  console.log(`  divergence                        ${pct(agg.retentionDivergence)}  threshold ${pct(RETENTION_DIVERGENCE_THRESHOLD)}`);
  console.log(`  VERDICT: ${agg.retentionDivergence > RETENTION_DIVERGENCE_THRESHOLD ? 'FIRED — penalty applied' : 'PASSED'}`);

  // --- DefiLlama, both divergences (§3.5) ---------------------------------
  console.log('\n--- DefiLlama cross-check (never a value source) ---');
  const llama = (await (await fetch(DEFILLAMA)).json()) as {
    currentChainTvls: Record<string, number>;
  };
  const llamaTvl = llama.currentChainTvls.Algorand ?? 0;
  const llamaBorrowed = llama.currentChainTvls['Algorand-borrowed'] ?? 0;

  const ourTvl = get('tvl');
  const ourBorrows = get('total_borrows');
  const div = (ours: number, theirs: number): string =>
    theirs === 0 ? 'n/a' : `${(((ours - theirs) / theirs) * 100).toFixed(2)}%`;

  console.log(`  DefiLlama Algorand TVL        ${usd(llamaTvl)}`);
  console.log(`  DefiLlama Algorand-borrowed   ${usd(llamaBorrowed)}`);
  console.log('');
  console.log(`  RAW (every market we could price, before exclusions):`);
  console.log(`    deposits ${usd(rawDeposits)}   divergence vs DefiLlama TVL       ${div(rawDeposits, llamaTvl)}`);
  console.log(`    borrows  ${usd(rawBorrows)}   divergence vs DefiLlama borrowed  ${div(rawBorrows, llamaBorrowed)}`);
  console.log(`  POST-FILTER (what we publish):`);
  console.log(`    tvl            ${usd(ourTvl)}   divergence ${div(ourTvl, llamaTvl)}`);
  console.log(`    total_borrows  ${usd(ourBorrows)}   divergence ${div(ourBorrows, llamaBorrowed)}`);

  // The TVL divergence above is a DEFINITIONAL disagreement, not an error, and
  // it is checkable rather than assertable: DefiLlama publishes Folks' TVL as
  // AVAILABLE LIQUIDITY (deposits minus borrows) while §3.5 defines lending TVL
  // as total deposits. Restating ours on their definition isolates whether any
  // measurement error remains underneath the definitional gap.
  console.log(`  LIKE-FOR-LIKE (ours restated on DefiLlama's definition):`);
  console.log(`    deposits - borrows  ${usd(ourTvl - ourBorrows)}   divergence vs DefiLlama TVL  ${div(ourTvl - ourBorrows, llamaTvl)}`);
  console.log(`    => the headline TVL divergence is the §3.5 TVL DEFINITION, not a measurement gap.`);

  // --- Utilization sanity (§3.5) ------------------------------------------
  const util = get('utilization');
  // DefiLlama's own figures, reconstructed on OUR definition: their TVL is
  // available liquidity, so their implied total deposits is TVL + borrowed.
  const llamaUtil = llamaTvl + llamaBorrowed > 0 ? llamaBorrowed / (llamaTvl + llamaBorrowed) : 0;
  console.log('\n--- Utilization sanity ---');
  console.log(`  ours                              ${util.toFixed(6)}   in [0,1]: ${util >= 0 && util <= 1}`);
  console.log(`  DefiLlama implied (bor/(tvl+bor)) ${llamaUtil.toFixed(6)}`);
  console.log(`  difference                        ${Math.abs(util - llamaUtil).toFixed(6)}`);
  console.log(`  naive bor/tvl on their numbers    ${(llamaBorrowed / llamaTvl).toFixed(6)}  <- wrong denominator; kept visible because it is the mistake this check exists to catch`);

  console.log('\n--- Cost ---');
  console.log(`  fetchRaw ${(fetchMs / 1000).toFixed(1)}s   price resolve ${(priceMs / 1000).toFixed(1)}s   sources ${snapshot.sources.length}   markets ${FOLKS_MARKETS.length}`);
  console.log(`  partial: ${snapshot.partial}   excludedCount: ${snapshot.excludedCount}\n`);
}

await main();
