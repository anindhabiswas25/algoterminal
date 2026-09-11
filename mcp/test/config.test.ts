import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config.js';

const env = (o: Record<string, string>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('defaults to the TestNet deployment with the documented caps', () => {
    const c = loadConfig(env({}));
    expect(c.network.id).toBe('testnet');
    expect(c.network.usdcAsaId).toBe('10458941');
    expect(c.baseUrl).toBe('https://api-testnet-production-a3ec.up.railway.app');
    expect(c.maxSessionAtomic).toBe(1_000_000n);
    expect(c.maxPerCallAtomic).toBe(50_000n);
  });

  it('has NO key by default — a bundled account would be the whole point missed', () => {
    const c = loadConfig(env({}));
    expect(c.mnemonic).toBeNull();
    expect(c.keySource).toBeNull();
  });

  it('switches network with one env var, and switches the asset with it', () => {
    const c = loadConfig(env({ ALGOTERMINAL_NETWORK: 'mainnet', ALGOTERMINAL_BASE_URL: 'https://example.test' }));
    expect(c.network.usdcAsaId).toBe('31566704');
    expect(c.network.caip2).toBe('algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=');
  });

  it('refuses mainnet without a base URL rather than guessing one', () => {
    expect(() => loadConfig(env({ ALGOTERMINAL_NETWORK: 'mainnet' }))).toThrow(/TestNet-only today/);
  });

  it('refuses a per-call cap above the session cap', () => {
    expect(() =>
      loadConfig(env({ ALGOTERMINAL_MAX_SPEND_USDC: '0.10', ALGOTERMINAL_MAX_PER_CALL_USDC: '0.50' })),
    ).toThrow(ConfigError);
  });

  it('reads a mnemonic from a keyfile, ignoring comments and line wrapping', () => {
    const dir = mkdtempSync(join(tmpdir(), 'algoterminal-mcp-'));
    const path = join(dir, 'payer.key');
    writeFileSync(path, '# my testnet payer\nabandon abandon abandon\nabandon abandon\n\n');
    const c = loadConfig(env({ ALGOTERMINAL_KEYFILE: path }));
    expect(c.mnemonic).toBe('abandon abandon abandon abandon abandon');
    expect(c.keySource).toBe('ALGOTERMINAL_KEYFILE');
  });

  it('expands a leading ~ in the keyfile path — an MCP config is not a shell', () => {
    // The path a user actually types. Nothing expands it on the way in, so if
    // this regresses, every keyfile setup fails with ENOENT on a file that exists.
    const rel = join('.algoterminal-mcp-test', 'payer.key');
    const dir = join(homedir(), '.algoterminal-mcp-test');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'payer.key');
    writeFileSync(path, 'alpha bravo charlie\n');
    try {
      const c = loadConfig(env({ ALGOTERMINAL_KEYFILE: `~/${rel}` }));
      expect(c.mnemonic).toBe('alpha bravo charlie');
      expect(c.keySource).toBe('ALGOTERMINAL_KEYFILE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shows both the path as written and the path it resolved to when it cannot read it', () => {
    let message = '';
    try {
      loadConfig(env({ ALGOTERMINAL_KEYFILE: '~/definitely-not-here.key' }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('~/definitely-not-here.key');
    expect(message).toContain(homedir());
  });

  it('prefers the inline mnemonic over a keyfile when both are set', () => {
    const c = loadConfig(env({ ALGOTERMINAL_MNEMONIC: 'word one two', ALGOTERMINAL_KEYFILE: '/nonexistent' }));
    expect(c.keySource).toBe('ALGOTERMINAL_MNEMONIC');
  });

  it('says which file it could not read, without ever printing a key', () => {
    let message = '';
    try {
      loadConfig(env({ ALGOTERMINAL_KEYFILE: '/definitely/not/here.key' }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('/definitely/not/here.key');
  });
});
