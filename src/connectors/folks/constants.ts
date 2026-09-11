import {
  MainnetDepositsAppId,
  MainnetPoolManagerAppId,
  MainnetPools,
  ONE_14_DP,
  ONE_16_DP,
  UINT64,
} from '@folks-finance/algorand-sdk';

/**
 * Everything this connector takes from `@folks-finance/algorand-sdk@0.2.6`,
 * re-exported through one file.
 *
 * ## Why the scale constants come from the SDK and are never written down here
 *
 * DATA_SCHEMA.md §3.5 carries a "do not skip" warning, and it is the most
 * important sentence in this connector's spec: Folks encodes every rate and
 * index as a fixed-point integer, and **a wrong decimal scale produces numbers
 * that are entirely plausible and entirely wrong**. A borrow rate read at 14 dp
 * instead of 16 is 344% instead of 3.44% — still a number, still positive,
 * still the right order of magnitude for a "high yield" headline, and wrong by
 * 100x.
 *
 * So no scale is inferred, assumed, or transcribed. Each one below names the
 * SDK's own constant for that specific field, sourced from the SDK's JSDoc at
 * `dist/lend/formulae.js` (which annotates every parameter and return with its
 * dp) and from `retrievePoolInfo` in `dist/lend/deposit.js` (which pairs each
 * raw global-state slot with the constant it is scaled by). The mapping is
 * pinned by a test that asserts our derived `supply_apr` matches the SDK's own
 * `retrievePoolInfo` output to within 1e-6 — see `test/connectors/folks`.
 *
 * The SDK version is pinned exactly (`0.2.6`, not `^0.2.6`) in `package.json`
 * for the same reason: a minor release that re-scaled a field would silently
 * change every Folks number we publish.
 */

/** The SDK version these constants were read from. Pinned in package.json. */
export const FOLKS_SDK_VERSION = '0.2.6';

/**
 * 16 dp — every RATE and every RATIO in Folks pool state.
 *
 * Source: `dist/lend/formulae.js` JSDoc, which annotates `variableBorrowInterestRate`,
 * `depositInterestRate`, `stableBorrowInterestRate`, `retentionRate` (`rr`),
 * `utilisationRatio` (`ut`) and the `vr*`/`sr*` curve parameters all as 16dp;
 * and `retrievePoolInfo`, which passes `ONE_16_DP` when compounding both the
 * borrow and the deposit rate.
 */
export const RATE_SCALE = ONE_16_DP;

/**
 * 14 dp — the cumulative interest INDICES, a different scale from the rates.
 *
 * Source: `calcBorrowInterestIndex` / `calcDepositInterestIndex` are documented
 * `@return ...InterestIndex (14dp)`, and `calcDepositReturn` / `calcWithdrawReturn`
 * divide and multiply by `ONE_14_DP`.
 *
 * This connector reads the indices but performs no arithmetic with them: they
 * are the input to §3.5's post-MVP exact method (diffing two snapshots 24h
 * apart for realized rather than run-rate interest). They are carried in the
 * snapshot so the snapshotter accumulates the history that method needs.
 *
 * That two scales coexist in one struct is exactly the trap §3.5 warns about,
 * and is why this file exists rather than a `1e16` at each call site.
 */
export const INDEX_SCALE = ONE_14_DP;

/** 2^64. `overallStableBorrowInterestAmount` is stored as a 128-bit pair. */
export const UINT64_SCALE = UINT64;

/** DATA_SCHEMA.md §3.5's `/365`: a simple-interest daily slice of an annual rate. */
export const DAYS_PER_YEAR = 365;

/** The pool-manager application; identifies the protocol on chain. */
export const POOL_MANAGER_APP_ID = MainnetPoolManagerAppId;
export const DEPOSITS_APP_ID = MainnetDepositsAppId;

/** One lending market, as the SDK declares it. */
export interface FolksMarket {
  /** The SDK's key, e.g. "ALGO", "ISOLATED_TINY". Used in notes, never as an id. */
  readonly name: string;
  /** The market's own application; its global state is the market. */
  readonly appId: number;
  /** The ASA deposited/borrowed. 0 is ALGO. */
  readonly assetId: number;
  /** Decimals for the ASA, from the SDK rather than from an asset lookup. */
  readonly assetDecimals: number;
}

/**
 * The market set: every mainnet pool the SDK declares, in SDK order.
 *
 * Enumerable, finite and pinned — which is what makes this connector's coverage
 * checkable. Unlike a DEX's pool catalogue there is no pagination and no
 * silent truncation risk: 25 markets on 2026-09-09.
 *
 * The list living in the SDK rather than on chain is a real dependency and is
 * stated as such in `README.md`: a market Folks deploys but does not ship in an
 * SDK release is invisible to us until we bump the pin. The alternative — an
 * on-chain enumeration through the pool manager — is recorded there as the
 * post-MVP improvement, with the reason it is not needed yet.
 */
export const FOLKS_MARKETS: readonly FolksMarket[] = Object.freeze(
  Object.entries(MainnetPools).map(([name, pool]) => ({
    name,
    appId: pool.appId,
    assetId: pool.assetId,
    assetDecimals: pool.assetDecimals,
  })),
);

/** Market lookup by application id. */
export const MARKET_BY_APP_ID: ReadonlyMap<number, FolksMarket> = new Map(
  FOLKS_MARKETS.map((m) => [m.appId, m]),
);
