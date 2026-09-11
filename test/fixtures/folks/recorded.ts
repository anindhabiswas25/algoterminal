import { readFileSync } from 'node:fs';
import path from 'node:path';

import { decodeAppState } from '../../../src/connectors/algod.js';
import { FOLKS_MARKETS, type FolksMarket } from '../../../src/connectors/folks/constants.js';
import { decodeMarket, type FolksEntity } from '../../../src/connectors/folks/schema.js';
import { makeContext, FROZEN_NOW } from '../../../src/connectors/testing.js';
import type { AppState, ConnectorContext, PriceTable, RawSnapshot } from '../../../src/connectors/types.js';

/**
 * Loading the recorded Folks fixtures — CONNECTOR_GUIDE.md §Step 6.
 *
 * `markets.json` holds verbatim algod `/v2/applications/{id}` responses;
 * `sdk-derived.json` holds what the pinned SDK's own `retrievePoolInfo` made of
 * the same applications at the same round. Nothing here computes: the loaders
 * decode, and every assertion lives in the test file.
 */

const DIR = path.resolve('test/fixtures/folks');

/** The round every recorded read is stamped with, so fixtures are stable. */
export const FIXTURE_ROUND = 64_873_935;

interface AlgodApplication {
  readonly id: number;
  readonly params: { readonly 'global-state': Array<{ key: string; value: { type: number; bytes?: string; uint?: number } }> };
}

export interface SdkDerivedMarket {
  readonly name: string;
  readonly appId: number;
  readonly assetId: number;
  readonly assetDecimals: number;
  readonly supply_apr: number;
  readonly variable_borrow_apr: number;
  readonly overall_borrow_apr: number;
  readonly retention_rate: number;
  readonly utilisation: number;
  readonly deposits: number;
  readonly variable_borrows: number;
  readonly stable_borrows: number;
  readonly deprecated: boolean;
  readonly stable_borrow_supported: boolean;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(DIR, file), 'utf8')) as T;
}

/** Verbatim algod responses, keyed by application id. */
export function recordedApplications(): Record<string, AlgodApplication> {
  return readJson<Record<string, AlgodApplication>>('markets.json');
}

/** What the pinned SDK derived from those same applications. */
export function sdkDerived(): { sdkVersion: string; markets: Record<string, SdkDerivedMarket> } {
  return readJson<{ sdkVersion: string; recordedAt: string; markets: Record<string, SdkDerivedMarket> }>(
    'sdk-derived.json',
  );
}

/** The frozen §3.7 price table. SILVER is absent on purpose (§3.6.1). */
export function recordedPrices(): PriceTable {
  const raw = readJson<{ asOf: string; prices: Record<string, { usd: number; confidence: number; source: string }> }>(
    'prices.json',
  );
  const prices: PriceTable['prices'] = {};
  for (const [id, entry] of Object.entries(raw.prices)) prices[Number(id)] = entry;
  return { asOf: raw.asOf, prices };
}

/** The recorded markets, as SDK market descriptors. */
export function recordedMarkets(): FolksMarket[] {
  const ids = new Set(Object.keys(recordedApplications()).map(Number));
  return FOLKS_MARKETS.filter((m) => ids.has(m.appId));
}

/** Decoded global state for one recorded application. */
export function recordedState(appId: number): AppState | null {
  const app = recordedApplications()[String(appId)];
  if (app === undefined) return null;
  return decodeAppState(app.params['global-state']);
}

/** One recorded market as a snapshot entity. */
export function recordedEntity(market: FolksMarket, round = FIXTURE_ROUND): FolksEntity {
  return decodeMarket(market, recordedState(market.appId), round);
}

/**
 * The recorded snapshot, exactly as `fetchRaw` would have returned it.
 *
 * Built here rather than by running `fetchRaw` against a stubbed algod so the
 * golden test asserts on `toFacts` alone; `fetchRaw` is exercised separately,
 * through {@link makeFixtureContext}.
 */
export function recordedSnapshot(overrides: Partial<RawSnapshot> = {}): RawSnapshot {
  const markets = recordedMarkets();
  return {
    entities: markets.map((m) => recordedEntity(m)),
    fetchedAt: FROZEN_NOW,
    sources: markets.map((m) => ({
      name: 'nodely-algod',
      url: `https://algod.test/v2/applications/${m.appId}`,
      kind: 'onchain' as const,
      retrieved_at: FROZEN_NOW,
      app_id: m.appId,
      round: FIXTURE_ROUND,
    })),
    partial: false,
    excludedCount: 0,
    ...overrides,
  };
}

/**
 * A {@link ConnectorContext} whose algod serves the recorded applications.
 *
 * §Step 6: "Stub what must never be called again." The indexer's
 * `listAccountsByApplication` throws — Folks enumerates from a pinned SDK
 * market list, never by walking accounts, and a connector that started doing so
 * would be scanning tens of thousands of user escrows to answer a question the
 * SDK already answers exactly.
 */
export function makeFixtureContext(
  options: { readonly failAppIds?: readonly number[]; readonly transactions?: readonly unknown[] } = {},
): ConnectorContext {
  const apps = recordedApplications();
  const fail = new Set(options.failAppIds ?? []);

  return makeContext({
    algod: {
      baseUrl: 'https://algod.test',
      status: async () => ({ lastRound: FIXTURE_ROUND }),
      getApplication: async (appId: number) => ({ round: FIXTURE_ROUND, application: apps[String(appId)] ?? {} }),
      getApplicationGlobalState: async (appId: number) => {
        if (fail.has(appId)) throw new Error(`algod is down for app ${appId}`);
        const app = apps[String(appId)];
        return {
          round: FIXTURE_ROUND,
          state: app === undefined ? null : decodeAppState(app.params['global-state']),
        };
      },
      getApplicationLocalState: async () => {
        throw new Error(
          'Folks reads APPLICATION global state, never account local state; this must not be called',
        );
      },
      getApplicationBox: async () => {
        throw new Error('Folks reads no boxes; this must not be called');
      },
    },
    indexer: {
      baseUrl: 'https://indexer.test',
      searchTransactions: async () => ({ transactions: options.transactions ?? [] }),
      listAccountsByApplication: async () => {
        throw new Error(
          'Folks enumerates markets from the pinned SDK list, never by walking accounts opted into an app',
        );
      },
    },
  });
}
