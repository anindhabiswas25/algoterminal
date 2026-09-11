import { describe, it, expect } from 'vitest';
import {
  networkConstants,
  activeNetwork,
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_TESTNET_CAIP2,
  USDC_MAINNET_ASA,
  USDC_TESTNET_ASA,
} from '../src/config/x402.js';

describe('x402 constants', () => {
  // Byte-for-byte against DEPLOYMENT.md §0. These strings are the difference
  // between a settled payment and a rejected one, so they are asserted as
  // literals rather than compared to the module's own exports.
  it('matches the mainnet constants in DEPLOYMENT.md §0', () => {
    expect(ALGORAND_MAINNET_CAIP2).toBe(
      'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
    );
    expect(USDC_MAINNET_ASA).toBe(31566704);
  });

  it('matches the testnet constants in DEPLOYMENT.md §0', () => {
    expect(ALGORAND_TESTNET_CAIP2).toBe(
      'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=',
    );
    expect(USDC_TESTNET_ASA).toBe(10458941);
  });

  it('resolves mainnet constants', () => {
    const n = networkConstants('mainnet');
    expect(n).toEqual({
      network: 'mainnet',
      caip2: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
      usdcAsaId: 31566704,
      usdcSymbol: 'USDC',
      usdcDecimals: 6,
      scheme: 'exact',
      x402Version: 2,
      algodUrl: 'https://mainnet-api.4160.nodely.dev',
      indexerUrl: 'https://mainnet-idx.4160.nodely.dev',
    });
  });

  it('resolves testnet constants', () => {
    const n = networkConstants('testnet');
    expect(n).toEqual({
      network: 'testnet',
      caip2: 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=',
      usdcAsaId: 10458941,
      usdcSymbol: 'USDC',
      usdcDecimals: 6,
      scheme: 'exact',
      x402Version: 2,
      algodUrl: 'https://testnet-api.4160.nodely.dev',
      indexerUrl: 'https://testnet-idx.4160.nodely.dev',
    });
  });

  it('never confuses the two networks', () => {
    expect(networkConstants('mainnet').caip2).not.toBe(networkConstants('testnet').caip2);
    expect(networkConstants('mainnet').usdcAsaId).not.toBe(networkConstants('testnet').usdcAsaId);
  });

  it('resolves the active network from env.X402_NETWORK', () => {
    // test/setup.ts pins X402_NETWORK=testnet.
    expect(activeNetwork()).toEqual(networkConstants('testnet'));
  });

  it('exposes frozen constants', () => {
    expect(Object.isFrozen(networkConstants('mainnet'))).toBe(true);
  });
});
