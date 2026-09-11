import { describe, it, expect } from 'vitest';
import { parseEnv, formatEnvIssues } from '../src/config/env.js';

function validEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    X402_NETWORK: 'testnet',
    X402_PAYTO: 'COMJM4YZ5PAFPG7AN3SMDGKQEBE3LPGIIQ4MLHYDEJVPX64E472UX6OYWY',
    X402_FACILITATOR_URL: 'https://facilitator.goplausible.xyz',
    ALGOD_URL: 'https://testnet-api.4160.nodely.dev',
    INDEXER_URL: 'https://testnet-idx.4160.nodely.dev',
    REDIS_URL: 'redis://localhost:6379',
    DATABASE_URL: 'postgres://localhost:5432/algoterminal',
    METHODOLOGY_VERSION: '1.1.0',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    LOG_LEVEL: 'silent',
  };
}

describe('env schema', () => {
  it('accepts a complete configuration', () => {
    const env = parseEnv(validEnv());
    expect(env.X402_NETWORK).toBe('testnet');
    expect(env.PORT).toBe(3000);
  });

  it('rejects a missing X402_PAYTO', () => {
    const source = validEnv();
    delete source.X402_PAYTO;
    expect(() => parseEnv(source)).toThrow();

    try {
      parseEnv(source);
      expect.unreachable('should have thrown');
    } catch (err) {
      const issues = formatEnvIssues((err as { issues: never[] }).issues);
      expect(issues.join('\n')).toContain('X402_PAYTO: missing (required)');
    }
  });

  it('rejects an address whose checksum does not verify', () => {
    // The right alphabet and the right length, one character transposed. A
    // charset-only check accepts this; the account it names does not exist, so
    // every 402 would quote a payTo that cannot receive.
    expect(() =>
      parseEnv({ ...validEnv(), X402_PAYTO: 'OCMJM4YZ5PAFPG7AN3SMDGKQEBE3LPGIIQ4MLHYDEJVPX64E472UX6OYWY' }),
    ).toThrow();
  });

  it('rejects a blank X402_PAYTO', () => {
    expect(() => parseEnv({ ...validEnv(), X402_PAYTO: '' })).toThrow();
  });

  it('rejects a malformed X402_FACILITATOR_URL', () => {
    expect(() => parseEnv({ ...validEnv(), X402_FACILITATOR_URL: 'not-a-url' })).toThrow();
  });

  it('rejects a malformed PUBLIC_BASE_URL', () => {
    expect(() => parseEnv({ ...validEnv(), PUBLIC_BASE_URL: 'localhost:3000' })).toThrow();
  });

  it('accepts localhost URLs, which local development depends on', () => {
    const env = parseEnv({ ...validEnv(), PUBLIC_BASE_URL: 'http://localhost:3000' });
    expect(env.PUBLIC_BASE_URL).toBe('http://localhost:3000');
  });

  it('rejects an unknown X402_NETWORK', () => {
    expect(() => parseEnv({ ...validEnv(), X402_NETWORK: 'devnet' })).toThrow();
  });

  it('rejects a non-semver METHODOLOGY_VERSION', () => {
    expect(() => parseEnv({ ...validEnv(), METHODOLOGY_VERSION: 'v1' })).toThrow();
  });

  // Both went from optional to required when the cache landed (step 5). A
  // service that boots without them serves every paid call from a ~65s
  // upstream fetch, which is unprofitable at $0.005 and unusable at any price
  // (ARCHITECTURE.md §4.5) — so it must not boot at all.
  it.each(['REDIS_URL', 'DATABASE_URL'] as const)('rejects a missing %s', (name) => {
    const source = validEnv();
    delete source[name];
    try {
      parseEnv(source);
      expect.unreachable('should have thrown');
    } catch (err) {
      const issues = formatEnvIssues((err as { issues: never[] }).issues);
      expect(issues.join('\n')).toContain(`${name}: missing (required)`);
    }
  });

  it('rejects a REDIS_URL that is not a redis:// URL', () => {
    expect(() => parseEnv({ ...validEnv(), REDIS_URL: 'nonsense' })).toThrow();
    expect(() => parseEnv({ ...validEnv(), REDIS_URL: 'http://localhost:6379' })).toThrow();
    expect(parseEnv({ ...validEnv(), REDIS_URL: 'rediss://host:6379' }).REDIS_URL).toBe(
      'rediss://host:6379',
    );
  });

  // /ask is step 10; this one is still genuinely optional.
  it('treats ANTHROPIC_API_KEY as optional', () => {
    expect(parseEnv(validEnv()).ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('returns a frozen object', () => {
    const env = parseEnv(validEnv());
    expect(Object.isFrozen(env)).toBe(true);
  });
});
