import { z } from 'zod';

import type { AppState } from '../types.js';
import { INDEX_SCALE, RATE_SCALE, UINT64_SCALE, type FolksMarket } from './constants.js';

/**
 * Decoding one Folks lending market out of application global state.
 *
 * ## The layout
 *
 * Folks does not keep one global-state key per parameter. It packs each group
 * of `uint64`s into a single byte-slice value, so the market's whole
 * configuration lives in five keys:
 *
 * | key  | contents                                    |
 * |------|---------------------------------------------|
 * | `v`  | variable-borrow params + totals + rate + index |
 * | `s`  | stable-borrow params + totals + rate + a 128-bit interest amount |
 * | `i`  | retention, deposits, deposit rate + index, last update |
 * | `ca` | caps                                        |
 * | `co` | config bits (deprecated, stable supported, …) |
 *
 * The slot indices below are read off `retrievePoolInfo` in the SDK
 * (`dist/lend/deposit.js`) rather than guessed, and a fixture test asserts this
 * decoder reproduces the SDK's own `retrievePoolInfo` output field for field.
 * That test is the whole safety argument for hand-decoding here instead of
 * calling the SDK's retriever: see the note on I/O below.
 *
 * ## Why we decode rather than call the SDK's retriever
 *
 * `retrievePoolInfo(client, pool)` wants an `algosdk.Algodv2` and does its own
 * network I/O. Using it would bypass `ctx.algod` — and with it the §4.1 retry
 * policy, the per-host concurrency cap, the identifying User-Agent, and the
 * `round` that makes an on-chain number reproducible (§4.2). CONNECTOR_GUIDE §4
 * is explicit that shared infrastructure must not be reimplemented or
 * bypassed, so the I/O stays on `ctx.algod` and only the *decoding and
 * arithmetic* come from the SDK — its slot layout, its scale constants, and
 * its formulae. The fixture test then pins the two together.
 */

/** Split a packed byte slice into big-endian `uint64`s. */
export function parseUint64s(bytes: Uint8Array): bigint[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: bigint[] = [];
  for (let offset = 0; offset + 8 <= bytes.byteLength; offset += 8) {
    out.push(view.getBigUint64(offset, false));
  }
  return out;
}

/**
 * The SDK's `parseBitsAsBooleans`, over bytes rather than base64: the config
 * value is a single packed byte whose bits are flags, MSB-first.
 */
export function parseBitsAsBooleans(bytes: Uint8Array): boolean[] {
  const byte = bytes.length > 0 ? (bytes[bytes.length - 1] as number) : 0;
  const bits: boolean[] = [];
  for (let shift = 7; shift >= 0; shift--) bits.push(((byte >> shift) & 1) === 1);
  return bits;
}

/** Read a byte-slice global-state key, or null when it is absent or a uint. */
function bytesAt(state: AppState, key: string): Uint8Array | null {
  const value = state[key];
  if (value === undefined || value.type !== 'bytes') return null;
  return value.bytes;
}

/**
 * Slot indices, from the SDK's `retrievePoolInfo`. Named rather than inlined:
 * `varBor[4]` at a call site is unreviewable, and an off-by-one here would swap
 * a rate for a total and still produce a plausible number.
 */
const SLOT = {
  /** `v` */ variableBorrowTotal: 3,
  /** `v` */ variableBorrowRate: 4,
  /** `v` */ variableBorrowIndexStored: 5,
  /** `s` */ stableBorrowTotal: 8,
  /** `s` */ stableBorrowRate: 9,
  /** `s` */ stableInterestAmountHigh: 10,
  /** `s` */ stableInterestAmountLow: 11,
  /** `i` */ retentionRate: 0,
  /** `i` */ totalDeposits: 3,
  /** `i` */ depositRate: 4,
  /** `i` */ depositIndexStored: 5,
  /** `i` */ latestUpdate: 6,
} as const;

/** The minimum slot counts a well-formed market must publish. */
const MIN_SLOTS = { v: 6, s: 12, i: 7 } as const;

/**
 * One market's raw state, still in Folks' fixed-point integers.
 *
 * Deliberately `bigint` and deliberately unscaled: the boundary between "what
 * the chain said" and "what it means in decimal" is exactly where §3.5's
 * warning lives, so it is crossed in exactly one place ({@link scaleMarket})
 * rather than wherever a number is first needed.
 */
export interface RawMarketState {
  readonly name: string;
  readonly appId: number;
  readonly assetId: number;
  readonly assetDecimals: number;
  readonly round: number;
  /** 0 dp, asset units. */
  readonly totalDeposits: bigint;
  /** 0 dp, asset units. */
  readonly variableBorrowTotal: bigint;
  /** 0 dp, asset units. */
  readonly stableBorrowTotal: bigint;
  /** 16 dp. */
  readonly depositRate: bigint;
  /** 16 dp. */
  readonly variableBorrowRate: bigint;
  /** 16 dp. */
  readonly stableBorrowRate: bigint;
  /**
   * 16 dp — Σ (stable principal × the rate it was fixed at), as a 128-bit
   * value split across two uint64 slots. It is an AMOUNT×RATE, not a rate, and
   * is what makes a blended borrow rate computable at all.
   */
  readonly stableInterestAmount: bigint;
  /** 16 dp — the protocol's share of borrower interest. */
  readonly retentionRate: bigint;
  /** 14 dp — stored index; carried for §3.5's post-MVP exact method only. */
  readonly depositIndexStored: bigint;
  /** 14 dp — likewise. */
  readonly variableBorrowIndexStored: bigint;
  /** Unix seconds of the market's last on-chain accrual. */
  readonly latestUpdate: bigint;
  /**
   * The `co` config bits, in the SDK's order: deprecated, rewardsPaused,
   * stableBorrowSupported, flashLoanSupported. The SDK spells the first
   * `depreciated`; the on-chain spelling is preserved in the decoder and
   * corrected in our own field name, because a typo faithfully propagated is
   * still a typo in our API.
   */
  readonly deprecated: boolean;
  readonly stableBorrowSupported: boolean;
}

/** A snapshot entity: one market, or a market that could not be read. */
export type FolksEntity =
  | { readonly kind: 'market'; readonly state: RawMarketState }
  | { readonly kind: 'unreadable'; readonly appId: number; readonly name: string; readonly reason: string };

export function isMarketEntity(
  entity: unknown,
): entity is { kind: 'market'; state: RawMarketState } {
  return (
    typeof entity === 'object' &&
    entity !== null &&
    (entity as { kind?: unknown }).kind === 'market'
  );
}

export function isUnreadableEntity(
  entity: unknown,
): entity is { kind: 'unreadable'; appId: number; name: string; reason: string } {
  return (
    typeof entity === 'object' &&
    entity !== null &&
    (entity as { kind?: unknown }).kind === 'unreadable'
  );
}

/**
 * The zod boundary for a market (§Step 4).
 *
 * Global state is bytes, not JSON, so the "schema" being validated is the
 * *shape of the packed arrays*: the three keys must exist, must be byte slices,
 * and must be long enough to contain the slots we index. A market that fails
 * any of those is skipped and counted — never coerced, and never defaulted to
 * zeros, which would enter the aggregate as a market holding no deposits rather
 * than as a market we failed to read (§1.5).
 */
export const MarketStateShape = z.object({
  v: z.array(z.bigint()).min(MIN_SLOTS.v),
  s: z.array(z.bigint()).min(MIN_SLOTS.s),
  i: z.array(z.bigint()).min(MIN_SLOTS.i),
});

/** Decode one market, or return the reason it could not be decoded. */
export function decodeMarket(
  market: FolksMarket,
  state: AppState | null,
  round: number,
): FolksEntity {
  const fail = (reason: string): FolksEntity => ({
    kind: 'unreadable',
    appId: market.appId,
    name: market.name,
    reason,
  });

  if (state === null) return fail('application has no global state');

  const raw = {
    v: bytesAt(state, 'v'),
    s: bytesAt(state, 's'),
    i: bytesAt(state, 'i'),
  };
  for (const [key, value] of Object.entries(raw)) {
    if (value === null) return fail(`global-state key "${key}" is missing or not a byte slice`);
  }

  const parsed = MarketStateShape.safeParse({
    v: parseUint64s(raw.v as Uint8Array),
    s: parseUint64s(raw.s as Uint8Array),
    i: parseUint64s(raw.i as Uint8Array),
  });
  if (!parsed.success) {
    return fail(`packed state is shorter than the SDK layout requires: ${parsed.error.message}`);
  }
  const { v, s, i } = parsed.data;
  const configBytes = bytesAt(state, 'co');
  const config = configBytes === null ? [] : parseBitsAsBooleans(configBytes);

  const at = (arr: readonly bigint[], index: number): bigint => arr[index] as bigint;

  return {
    kind: 'market',
    state: {
      name: market.name,
      appId: market.appId,
      assetId: market.assetId,
      assetDecimals: market.assetDecimals,
      round,
      totalDeposits: at(i, SLOT.totalDeposits),
      variableBorrowTotal: at(v, SLOT.variableBorrowTotal),
      stableBorrowTotal: at(s, SLOT.stableBorrowTotal),
      depositRate: at(i, SLOT.depositRate),
      variableBorrowRate: at(v, SLOT.variableBorrowRate),
      stableBorrowRate: at(s, SLOT.stableBorrowRate),
      // The SDK's own reconstruction of the 128-bit value:
      // `stblBor[10] * UINT64 + stblBor[11]`.
      stableInterestAmount:
        at(s, SLOT.stableInterestAmountHigh) * UINT64_SCALE + at(s, SLOT.stableInterestAmountLow),
      retentionRate: at(i, SLOT.retentionRate),
      depositIndexStored: at(i, SLOT.depositIndexStored),
      variableBorrowIndexStored: at(v, SLOT.variableBorrowIndexStored),
      latestUpdate: at(i, SLOT.latestUpdate),
      // `co` is absent on a market that has never had a flag set; absent flags
      // are false, which is the same thing the on-chain default means.
      deprecated: config[0] ?? false,
      stableBorrowSupported: config[2] ?? false,
    },
  };
}

/**
 * One market, converted out of fixed point into decimals — **the only place a
 * scale is applied**.
 *
 * Rates become dimensionless fractions per DATA_SCHEMA.md §2.1 (`0.0369` is
 * 3.69%, never a percent), and amounts become whole asset units. Every division
 * names the SDK constant for that field; none is a literal.
 */
export interface ScaledMarket {
  readonly name: string;
  readonly appId: number;
  readonly assetId: number;
  readonly round: number;
  /** Whole asset units. */
  readonly deposits: number;
  readonly variableBorrows: number;
  readonly stableBorrows: number;
  /** `variableBorrows + stableBorrows` — the SDK's `calcTotalDebt`. */
  readonly borrows: number;
  /** Dimensionless annual fractions. */
  readonly depositRate: number;
  readonly variableBorrowRate: number;
  readonly stableBorrowRate: number;
  /**
   * The debt-weighted annual borrow rate across variable AND stable debt — the
   * SDK's `calcOverallBorrowInterestRate`. See `index.ts` for why this, and not
   * `variableBorrowRate`, is what `gross_fees_24h` multiplies.
   */
  readonly overallBorrowRate: number;
  readonly retentionRate: number;
  /** 14 dp indices, descaled; carried for the post-MVP exact method. */
  readonly depositIndex: number;
  readonly variableBorrowIndex: number;
  readonly deprecated: boolean;
  readonly stableBorrowSupported: boolean;
}

/** Descale one market. Pure. */
export function scaleMarket(raw: RawMarketState): ScaledMarket {
  const unit = 10 ** raw.assetDecimals;
  const rate = (fixed: bigint): number => Number(fixed) / Number(RATE_SCALE);

  const deposits = Number(raw.totalDeposits) / unit;
  const variableBorrows = Number(raw.variableBorrowTotal) / unit;
  const stableBorrows = Number(raw.stableBorrowTotal) / unit;
  const borrows = variableBorrows + stableBorrows;

  // The SDK's calcOverallBorrowInterestRate, in decimals:
  //   (totalVarDebt * vbirt + osbiat) / totalDebt
  // `stableInterestAmount` is already an amount x rate (16 dp), so it is
  // descaled by the RATE scale and by the asset unit — the same two divisions
  // its two factors would have taken separately.
  const variableInterest = variableBorrows * rate(raw.variableBorrowRate);
  const stableInterest = Number(raw.stableInterestAmount) / Number(RATE_SCALE) / unit;
  const overallBorrowRate = borrows > 0 ? (variableInterest + stableInterest) / borrows : 0;

  return {
    name: raw.name,
    appId: raw.appId,
    assetId: raw.assetId,
    round: raw.round,
    deposits,
    variableBorrows,
    stableBorrows,
    borrows,
    depositRate: rate(raw.depositRate),
    variableBorrowRate: rate(raw.variableBorrowRate),
    stableBorrowRate: rate(raw.stableBorrowRate),
    overallBorrowRate,
    retentionRate: rate(raw.retentionRate),
    depositIndex: Number(raw.depositIndexStored) / Number(INDEX_SCALE),
    variableBorrowIndex: Number(raw.variableBorrowIndexStored) / Number(INDEX_SCALE),
    deprecated: raw.deprecated,
    stableBorrowSupported: raw.stableBorrowSupported,
  };
}
