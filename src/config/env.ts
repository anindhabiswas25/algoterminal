import algosdk from 'algosdk';
import { z } from 'zod';

/**
 * Every environment variable listed in DEPLOYMENT.md §3.
 *
 * Parsed exactly once, at module load. A service that boots with a blank
 * X402_PAYTO emits 402s pointing at nowhere and quietly collects nothing, so
 * validation must fail loud at boot rather than lazily at first payment.
 */
// `z.url()` alone accepts things like `localhost:3000` (protocol `localhost:`),
// which is exactly the malformed value a hand-edited .env produces. Pin the
// protocol so a base URL that cannot be fetched fails at boot.
const httpUrl = z.url({ protocol: /^https?$/ });
const redisUrl = z.url({ protocol: /^rediss?$/ });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),

  X402_NETWORK: z.enum(['mainnet', 'testnet']),
  // Algorand addresses are 58 characters of base32 (RFC 4648, no padding) whose
  // last four bytes are a checksum over the public key. The charset check alone
  // accepts a transposed or truncated address, and the failure mode for that is
  // the exact one this file exists to prevent: 402s quoting a payTo that cannot
  // receive, discovered when the first payment fails rather than at boot.
  X402_PAYTO: z
    .string()
    .regex(/^[A-Z2-7]{58}$/, 'must be a 58-character Algorand address (base32, A-Z and 2-7)')
    .refine((value) => algosdk.isValidAddress(value), 'checksum is invalid'),
  X402_FACILITATOR_URL: httpUrl,

  ALGOD_URL: httpUrl,
  INDEXER_URL: httpUrl,

  // REQUIRED as of build step 5 (the cache). Redis is L1 and holds the
  // stampede lock; Postgres is L2, the last-known-good store. Both were
  // optional while nothing read them; leaving them optional now would let the
  // service boot into a configuration where every paid call is a 70-second
  // upstream fetch — unprofitable at $0.005 and unusable at any price
  // (ARCHITECTURE.md §1.2, §4.5). Fail at boot instead.
  REDIS_URL: redisUrl,
  DATABASE_URL: z.string().min(1),
  // Still optional: /ask arrives at step 10.
  ANTHROPIC_API_KEY: z.string().min(1).optional(),

  /**
   * Our own Algorand addresses, comma-separated — DEPLOYMENT.md §7.2's second
   * query, made operable (LAUNCH_LOG.md §4g item 5).
   *
   * §7.2: "our own addresses must never appear after the §5.1 verification
   * txn", and "if the second query returns anything beyond the one logged
   * verification payment, stop and investigate — that is the failure mode that
   * disqualifies an entry". That is an alarm, not a report, and an alarm whose
   * subject is hardcoded stops working the moment the mainnet `payTo` or a new
   * test buyer is added. It is configuration for exactly that reason.
   *
   * Optional and empty by default: a deployment that has not listed its own
   * addresses gets a concentration report that says so, rather than a green
   * light it has not earned. `/health` reports `own_addresses_configured`.
   *
   * Each entry is validated the same way `X402_PAYTO` is — alphabet AND
   * checksum — because a transposed address here silently monitors nothing.
   */
  OWN_PAYER_ADDRESSES: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined
        ? []
        : value
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
    )
    .refine(
      (list) => list.every((address) => /^[A-Z2-7]{58}$/.test(address) && algosdk.isValidAddress(address)),
      'every entry must be a valid 58-character Algorand address, comma-separated',
    ),

  METHODOLOGY_VERSION: z.string().regex(/^\d+\.\d+\.\d+$/, 'must be semver, e.g. 1.0.0'),
  PUBLIC_BASE_URL: httpUrl,
  /**
   * The TestNet twin of this deployment, advertised on `/llms.txt` and the
   * landing page as the free evaluation surface (PRD.md §7.5: an agent must be
   * able to fully evaluate us without paying, so that every mainnet payment
   * represents genuine demand).
   *
   * Optional, and it is the TestNet service itself that leaves it unset — a
   * deployment that IS the TestNet twin has nothing to point at but itself.
   * Set it on the mainnet service.
   */
  TESTNET_BASE_URL: httpUrl.optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = Readonly<z.infer<typeof EnvSchema>>;

/**
 * Renders zod issues as one line per offending variable. Exported for tests so
 * the failure path is covered without spawning a process.
 */
export function formatEnvIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.map((issue) => {
    const name = issue.path.join('.') || '(root)';
    const missing = issue.code === 'invalid_type' && issue.input === undefined;
    return `  ${name}: ${missing ? 'missing (required)' : issue.message}`;
  });
}

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  return Object.freeze(EnvSchema.parse(source));
}

function loadOrExit(source: NodeJS.ProcessEnv): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const lines = formatEnvIssues(result.error.issues);
    process.stderr.write(
      `Invalid environment configuration — refusing to start.\n${lines.join('\n')}\n` +
        `See docs/DEPLOYMENT.md §3 and .env.example for the full list.\n`,
    );
    process.exit(1);
  }
  return Object.freeze(result.data);
}

export const env: Env = loadOrExit(process.env);
