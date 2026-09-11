import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import algosdk from 'algosdk';
import {
  MainnetPools,
  ONE_16_DP,
  calcOverallBorrowInterestRate,
  calcTotalDebt,
  calcUtilisationRatio,
  retrievePoolInfo,
} from '@folks-finance/algorand-sdk';

import { FOLKS_SDK_VERSION } from '../src/connectors/folks/constants.js';

/**
 * Record the Folks fixtures — CONNECTOR_GUIDE.md §Step 6.
 *
 * `npx tsx scripts/record-folks-fixtures.ts`
 *
 * ## What is recorded, and why these markets
 *
 * §Step 6: "Record fixtures that exercise the exclusion paths. A fixture
 * holding only healthy entities lets every `coverage.excluded` branch rot
 * untested while the suite stays green." The subset below is chosen, not
 * sampled:
 *
 * | market | what it exercises |
 * |---|---|
 * | `ALGO` | the dominant market; 1.8% stable debt |
 * | `USDC` | large, 21.6% stable debt, price confidence 1.00 |
 * | `ISOLATED_TINY` | **54% stable debt** — the market that proves the blended borrow rate. Under §3.5's literal variable-only formula this one alone breaks the retention cross-check and yields negative protocol revenue |
 * | `xALGO` | the largest market by deposits but near-zero borrows: the "big TVL, no flow" shape |
 * | `gALGO` | **zero borrows and zero rates** — the division-by-zero path |
 * | `OPUL` | deprecated, dust, and **10 asset decimals** rather than 6 or 8 |
 * | `SILVER` | left deliberately UNPRICED in `prices.json`, so §3.6.1's exclusion path is exercised by the golden fixture rather than only by a synthetic test |
 *
 * ## Two files, deliberately
 *
 * `markets.json` is the verbatim algod response for each market — the bytes our
 * decoder must handle. `sdk-derived.json` is what
 * `@folks-finance/algorand-sdk@<pinned>`'s own `retrievePoolInfo` made of the
 * SAME application at the SAME round. Recording both is what lets the
 * SDK-agreement test §3.5 demands run offline and deterministically: it pins
 * our decoding and our fixed-point scales against the SDK's, with no network
 * and no clock.
 */

const ALGOD = process.env.MAINNET_ALGOD_URL ?? 'https://mainnet-api.4160.nodely.dev';
const OUT = path.resolve('test/fixtures/folks');

const RECORDED_MARKETS = [
  'ALGO',
  'USDC',
  'ISOLATED_TINY',
  'xALGO',
  'gALGO',
  'OPUL',
  'SILVER',
] as const;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const client = new algosdk.Algodv2('', ALGOD, '');

  const markets: Record<string, unknown> = {};
  const derived: Record<string, unknown> = {};

  for (const name of RECORDED_MARKETS) {
    const pool = MainnetPools[name as keyof typeof MainnetPools];
    // Verbatim: exactly what ctx.algod.getApplicationGlobalState parses.
    const raw = await (await fetch(`${ALGOD}/v2/applications/${pool.appId}`)).json();
    markets[String(pool.appId)] = raw;

    const info = await retrievePoolInfo(client, pool);
    const totalDebt = calcTotalDebt(
      info.variableBorrow.totalVariableBorrowAmount,
      info.stableBorrow.totalStableBorrowAmount,
    );
    const overall = calcOverallBorrowInterestRate(
      info.variableBorrow.totalVariableBorrowAmount,
      totalDebt,
      info.variableBorrow.variableBorrowInterestRate,
      info.stableBorrow.overallStableBorrowInterestAmount,
    );

    // Only the fields our KPIs use, already descaled by the SDK's OWN
    // constants. The interest INDICES are deliberately absent: the SDK
    // projects them to `unixTime()`, so recording one would bake a clock into
    // a fixture that must be deterministic — and this connector performs no
    // arithmetic with them (see constants.ts, INDEX_SCALE).
    derived[String(pool.appId)] = {
      name,
      appId: pool.appId,
      assetId: pool.assetId,
      assetDecimals: pool.assetDecimals,
      supply_apr: Number(info.interest.depositInterestRate) / Number(ONE_16_DP),
      variable_borrow_apr:
        Number(info.variableBorrow.variableBorrowInterestRate) / Number(ONE_16_DP),
      overall_borrow_apr: Number(overall) / Number(ONE_16_DP),
      retention_rate: Number(info.interest.retentionRate) / Number(ONE_16_DP),
      utilisation: Number(calcUtilisationRatio(totalDebt, info.interest.totalDeposits)) / Number(ONE_16_DP),
      deposits: Number(info.interest.totalDeposits) / 10 ** pool.assetDecimals,
      variable_borrows:
        Number(info.variableBorrow.totalVariableBorrowAmount) / 10 ** pool.assetDecimals,
      stable_borrows: Number(info.stableBorrow.totalStableBorrowAmount) / 10 ** pool.assetDecimals,
      deprecated: info.config.depreciated,
      stable_borrow_supported: info.config.stableBorrowSupported,
    };
    process.stdout.write(`recorded ${name} (${pool.appId})\n`);
  }

  writeFileSync(path.join(OUT, 'markets.json'), `${JSON.stringify(markets, null, 2)}\n`);
  writeFileSync(
    path.join(OUT, 'sdk-derived.json'),
    `${JSON.stringify({ sdkVersion: FOLKS_SDK_VERSION, recordedAt: new Date().toISOString(), markets: derived }, null, 2)}\n`,
  );

  process.stdout.write(`\nWrote ${RECORDED_MARKETS.length} markets to ${OUT}\n`);
  process.stdout.write(
    'prices.json is hand-maintained (SILVER is omitted on purpose, to exercise §3.6.1).\n',
  );
}

await main();
