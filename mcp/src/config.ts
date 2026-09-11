/**
 * Configuration, entirely from the environment.
 *
 * The single rule this file exists to enforce: **the key is the user's**. There
 * is no bundled account, no fallback mnemonic, no service wallet to fall back
 * on. If the user has not supplied a key, the paid tools say so and stop — they
 * do not quietly route the call through somebody else's funds. That is the whole
 * proposition of x402, and paying on a user's behalf would also be exactly the
 * self-generated volume the Algorand x402 Challenge disqualifies.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export type NetworkId = 'testnet' | 'mainnet';

export interface NetworkConstants {
  readonly id: NetworkId;
  /** CAIP-2 chain id, as the service advertises it in the 402. */
  readonly caip2: `${string}:${string}`;
  /** USDC ASA id on this chain. */
  readonly usdcAsaId: string;
  readonly usdcDecimals: 6;
  /** Algod used to BUILD the payment transaction — never to read AlgoTerminal's data. */
  readonly algodUrl: string;
  readonly explorerTxBase: string;
  readonly explorerAddressBase: string;
  /** The AlgoTerminal deployment that settles on this chain. */
  readonly defaultBaseUrl: string | null;
}

/**
 * The data AlgoTerminal serves is Algorand MainNet, always. The network below is
 * the chain the *payment* settles on. Those are two different things and
 * conflating them is the mistake worth designing against.
 */
export const NETWORKS: Record<NetworkId, NetworkConstants> = {
  testnet: {
    id: 'testnet',
    caip2: 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=',
    usdcAsaId: '10458941',
    usdcDecimals: 6,
    algodUrl: 'https://testnet-api.4160.nodely.dev',
    explorerTxBase: 'https://testnet.explorer.perawallet.app/tx',
    explorerAddressBase: 'https://testnet.explorer.perawallet.app/address',
    defaultBaseUrl: 'https://api-testnet-production-a3ec.up.railway.app',
  },
  mainnet: {
    id: 'mainnet',
    caip2: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
    usdcAsaId: '31566704',
    usdcDecimals: 6,
    algodUrl: 'https://mainnet-api.4160.nodely.dev',
    explorerTxBase: 'https://explorer.perawallet.app/tx',
    explorerAddressBase: 'https://explorer.perawallet.app/address',
    // There is no MainNet deployment yet. Switching networks without also
    // setting ALGOTERMINAL_BASE_URL is a configuration error, not a default.
    defaultBaseUrl: null,
  },
};

export interface Config {
  readonly baseUrl: string;
  readonly network: NetworkConstants;
  /** 25-word mnemonic, or null when the user has configured no key. */
  readonly mnemonic: string | null;
  /** Where the mnemonic came from, for diagnostics that never print the key. */
  readonly keySource: 'ALGOTERMINAL_MNEMONIC' | 'ALGOTERMINAL_KEYFILE' | null;
  /** Session cap, in atomic USDC (6dp). */
  readonly maxSessionAtomic: bigint;
  /** Per-call cap, in atomic USDC (6dp). */
  readonly maxPerCallAtomic: bigint;
  readonly requestTimeoutMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** `"1.00"` -> `1000000n`. Rejects anything that is not a plain decimal amount. */
export function usdcToAtomic(input: string, label: string): bigint {
  const trimmed = input.trim().replace(/^\$/, '');
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) {
    throw new ConfigError(
      `${label} must be a plain USDC amount with at most 6 decimal places, e.g. "1.00". Got: ${JSON.stringify(input)}`,
    );
  }
  const [whole, frac = ''] = trimmed.split('.');
  return BigInt(whole ?? '0') * 1_000_000n + BigInt(frac.padEnd(6, '0'));
}

/** `1000000n` -> `"1.000000"`. Never rounds; the caller sees every digit it spent. */
export function atomicToUsdc(atomic: bigint): string {
  const negative = atomic < 0n;
  const abs = negative ? -atomic : atomic;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

/**
 * Expand a leading `~` and make the path absolute.
 *
 * This is not a convenience. The path arrives from an MCP client's JSON config,
 * which is not a shell — nothing expands `~` on the way in, and nothing
 * establishes a working directory either. A user who writes the obvious
 * `~/.algoterminal/payer.key` gets ENOENT on a file that plainly exists, and the
 * error points at the wrong thing entirely.
 */
export function expandPath(input: string): string {
  const expanded = input === '~' || input.startsWith('~/') ? input.replace('~', homedir()) : input;
  return resolve(expanded);
}

function readMnemonic(env: NodeJS.ProcessEnv): {
  mnemonic: string | null;
  keySource: Config['keySource'];
} {
  const inline = env.ALGOTERMINAL_MNEMONIC?.trim();
  if (inline !== undefined && inline !== '') {
    return { mnemonic: inline, keySource: 'ALGOTERMINAL_MNEMONIC' };
  }

  const keyfileRaw = env.ALGOTERMINAL_KEYFILE?.trim();
  if (keyfileRaw !== undefined && keyfileRaw !== '') {
    const keyfile = expandPath(keyfileRaw);
    let contents: string;
    try {
      contents = readFileSync(keyfile, 'utf8');
    } catch (cause) {
      throw new ConfigError(
        `ALGOTERMINAL_KEYFILE points at ${keyfileRaw}${keyfile === keyfileRaw ? '' : ` (${keyfile})`}, ` +
          `which could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    // A keyfile is a mnemonic and nothing else. Strip comment lines so a user
    // can annotate the file, and collapse the whitespace so a wrapped 25 words
    // works as well as one line.
    const words = contents
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join(' ')
      .trim()
      .split(/\s+/)
      .filter((w) => w !== '');
    if (words.length === 0) {
      throw new ConfigError(`ALGOTERMINAL_KEYFILE (${keyfile}) contains no words.`);
    }
    return { mnemonic: words.join(' '), keySource: 'ALGOTERMINAL_KEYFILE' };
  }

  return { mnemonic: null, keySource: null };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const networkId = (env.ALGOTERMINAL_NETWORK?.trim() ?? 'testnet') as NetworkId;
  if (networkId !== 'testnet' && networkId !== 'mainnet') {
    throw new ConfigError(
      `ALGOTERMINAL_NETWORK must be "testnet" or "mainnet". Got: ${JSON.stringify(env.ALGOTERMINAL_NETWORK)}`,
    );
  }

  const base = NETWORKS[networkId];
  const network: NetworkConstants =
    env.ALGOTERMINAL_ALGOD_URL?.trim() !== undefined && env.ALGOTERMINAL_ALGOD_URL.trim() !== ''
      ? { ...base, algodUrl: env.ALGOTERMINAL_ALGOD_URL.trim().replace(/\/+$/, '') }
      : base;

  const explicitBase = env.ALGOTERMINAL_BASE_URL?.trim();
  const baseUrl = explicitBase !== undefined && explicitBase !== '' ? explicitBase : network.defaultBaseUrl;
  if (baseUrl === null || baseUrl === undefined) {
    throw new ConfigError(
      'ALGOTERMINAL_NETWORK=mainnet has no default deployment yet — AlgoTerminal is TestNet-only today. ' +
        'Set ALGOTERMINAL_BASE_URL to the MainNet deployment once it exists, or drop ALGOTERMINAL_NETWORK to use TestNet.',
    );
  }

  const maxSessionAtomic = usdcToAtomic(
    env.ALGOTERMINAL_MAX_SPEND_USDC?.trim() ?? '1.00',
    'ALGOTERMINAL_MAX_SPEND_USDC',
  );
  const maxPerCallAtomic = usdcToAtomic(
    env.ALGOTERMINAL_MAX_PER_CALL_USDC?.trim() ?? '0.05',
    'ALGOTERMINAL_MAX_PER_CALL_USDC',
  );
  if (maxPerCallAtomic > maxSessionAtomic) {
    throw new ConfigError(
      `ALGOTERMINAL_MAX_PER_CALL_USDC (${atomicToUsdc(maxPerCallAtomic)}) exceeds ` +
        `ALGOTERMINAL_MAX_SPEND_USDC (${atomicToUsdc(maxSessionAtomic)}). The session cap is the ` +
        'outer bound; a per-call cap above it can never be reached and is more likely a typo than an intent.',
    );
  }

  const { mnemonic, keySource } = readMnemonic(env);

  const timeoutRaw = env.ALGOTERMINAL_TIMEOUT_MS?.trim();
  const requestTimeoutMs = timeoutRaw === undefined || timeoutRaw === '' ? 60_000 : Number(timeoutRaw);
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new ConfigError(`ALGOTERMINAL_TIMEOUT_MS must be a positive number of milliseconds. Got: ${timeoutRaw}`);
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    network,
    mnemonic,
    keySource,
    maxSessionAtomic,
    maxPerCallAtomic,
    requestTimeoutMs,
  };
}
