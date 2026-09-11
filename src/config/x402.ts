import { env } from './env.js';

/**
 * The x402 / Algorand constants from DEPLOYMENT.md §0.
 *
 * This file is the ONLY place these strings are typed by hand. Every other
 * module must import from here — a mistyped CAIP-2 id or ASA id fails as a
 * rejected settlement in production, not as a compile error.
 */

export const ALGORAND_MAINNET_CAIP2 = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';
export const ALGORAND_TESTNET_CAIP2 = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=';

export const USDC_MAINNET_ASA = 31566704;
export const USDC_TESTNET_ASA = 10458941;
export const USDC_DECIMALS = 6;
export const USDC_SYMBOL = 'USDC';

/**
 * API_SPEC.md §2.1 — the GoPlausible facilitator sponsors the fee-payer
 * transaction, so a caller needs no ALGO, only USDC. Advertised on `/catalog`
 * as `payment.fee_sponsored`; it is a property of the facilitator we point at,
 * so it lives with the rest of the x402 constants rather than being retyped in
 * the route that publishes it.
 */
export const FEE_SPONSORED = true;

export const SCHEME = 'exact';
export const X402_VERSION = 2;

export const ALGOD_MAINNET = 'https://mainnet-api.4160.nodely.dev';
export const INDEXER_MAINNET = 'https://mainnet-idx.4160.nodely.dev';
export const ALGOD_TESTNET = 'https://testnet-api.4160.nodely.dev';
export const INDEXER_TESTNET = 'https://testnet-idx.4160.nodely.dev';

export type NetworkId = 'mainnet' | 'testnet';

export interface NetworkConstants {
  readonly network: NetworkId;
  readonly caip2: string;
  readonly usdcAsaId: number;
  readonly usdcSymbol: typeof USDC_SYMBOL;
  readonly usdcDecimals: number;
  readonly scheme: typeof SCHEME;
  readonly x402Version: typeof X402_VERSION;
  readonly algodUrl: string;
  readonly indexerUrl: string;
}

const NETWORKS: Readonly<Record<NetworkId, NetworkConstants>> = Object.freeze({
  mainnet: Object.freeze({
    network: 'mainnet',
    caip2: ALGORAND_MAINNET_CAIP2,
    usdcAsaId: USDC_MAINNET_ASA,
    usdcSymbol: USDC_SYMBOL,
    usdcDecimals: USDC_DECIMALS,
    scheme: SCHEME,
    x402Version: X402_VERSION,
    algodUrl: ALGOD_MAINNET,
    indexerUrl: INDEXER_MAINNET,
  }),
  testnet: Object.freeze({
    network: 'testnet',
    caip2: ALGORAND_TESTNET_CAIP2,
    usdcAsaId: USDC_TESTNET_ASA,
    usdcSymbol: USDC_SYMBOL,
    usdcDecimals: USDC_DECIMALS,
    scheme: SCHEME,
    x402Version: X402_VERSION,
    algodUrl: ALGOD_TESTNET,
    indexerUrl: INDEXER_TESTNET,
  }),
});

/** Constants for an explicitly named network. */
export function networkConstants(network: NetworkId): NetworkConstants {
  return NETWORKS[network];
}

/** Constants for the network this process is configured for (env.X402_NETWORK). */
export function activeNetwork(): NetworkConstants {
  return NETWORKS[env.X402_NETWORK];
}
