import { z } from 'zod';

import type { AlgodClient, AppState, AppStateValue, HttpClient } from './types.js';

/**
 * CONNECTOR_GUIDE.md §4.2 — the shared Nodely algod client.
 *
 * Every read here is zod-validated at the boundary for the same reason a
 * connector's REST payload is (§Step 4): algod is an upstream like any other,
 * and a missing `round` silently becoming `undefined` would put an
 * unreproducible number in a paid response.
 */

/** algod encodes state keys and byte values as base64. */
const StateValueSchema = z.object({
  type: z.number().int(),
  bytes: z.string().default(''),
  uint: z.number().default(0),
});

const KeyValueSchema = z.object({ key: z.string(), value: StateValueSchema });

const AccountSchema = z.object({
  round: z.number().int().nonnegative(),
  'apps-local-state': z
    .array(z.object({ id: z.number().int(), 'key-value': z.array(KeyValueSchema).default([]) }))
    .default([]),
});

const StatusSchema = z.object({ 'last-round': z.number().int().nonnegative() });

const ApplicationSchema = z.looseObject({ id: z.number().int() });

/**
 * The application envelope, narrowed to the global state we actually read.
 * `looseObject` on `params` so an algod that grows a field does not fail the
 * parse — the §Step 4 rule is to validate what we read, not to freeze upstream.
 */
const GlobalStateAppSchema = z.object({
  id: z.number().int(),
  params: z.looseObject({ 'global-state': z.array(KeyValueSchema).default([]) }),
});

/**
 * algod's `value.type`: 1 is a byte slice, 2 is a uint. Modelling it as the
 * discriminated {@link AppStateValue} at the boundary is what stops a caller
 * reading `.uint` off a byte slice and getting a plausible `0`.
 */
export function decodeStateValue(value: z.infer<typeof StateValueSchema>): AppStateValue {
  return value.type === 2
    ? { type: 'uint', uint: value.uint }
    : { type: 'bytes', bytes: Uint8Array.from(Buffer.from(value.bytes, 'base64')) };
}

/** Decode a `key-value` array into {@link AppState}, keys base64 → UTF-8. */
export function decodeAppState(entries: readonly z.infer<typeof KeyValueSchema>[]): AppState {
  const state: Record<string, AppStateValue> = {};
  for (const entry of entries) {
    state[Buffer.from(entry.key, 'base64').toString('utf8')] = decodeStateValue(entry.value);
  }
  return state;
}

export interface AlgodOptions {
  readonly baseUrl: string;
  readonly http: HttpClient;
}

export function createAlgodClient({ baseUrl, http }: AlgodOptions): AlgodClient {
  const root = baseUrl.replace(/\/+$/, '');

  return {
    baseUrl: root,

    async status() {
      const parsed = StatusSchema.parse(await http.getJson(`${root}/v2/status`));
      return { lastRound: parsed['last-round'] };
    },

    async getApplication(appId: number) {
      // algod's /v2/applications/{id} carries no round of its own, so the round
      // is read alongside it. Recording the ledger round is not optional
      // bookkeeping — §4.2 makes it the difference between a reproducible
      // on-chain number and an unfalsifiable one.
      const [status, application] = await Promise.all([
        http.getJson(`${root}/v2/status`),
        http.getJson(`${root}/v2/applications/${appId}`),
      ]);
      return {
        round: StatusSchema.parse(status)['last-round'],
        application: ApplicationSchema.parse(application),
      };
    },

    async getApplicationGlobalState(appId: number) {
      // Same two-call shape as `getApplication`: algod's application endpoint
      // carries no round of its own, and an on-chain number without a round is
      // not reproducible (§4.2, DATA_SCHEMA.md §1.4).
      const [status, application] = await Promise.all([
        http.getJson(`${root}/v2/status`),
        http.getJson(`${root}/v2/applications/${appId}`),
      ]);
      const parsed = GlobalStateAppSchema.safeParse(application);
      return {
        round: StatusSchema.parse(status)['last-round'],
        state: parsed.success ? decodeAppState(parsed.data.params['global-state']) : null,
      };
    },

    async getApplicationLocalState(address: string, appId: number) {
      const account = AccountSchema.parse(
        await http.getJson(`${root}/v2/accounts/${address}`),
      );
      const entry = account['apps-local-state'].find((s) => s.id === appId);
      return {
        round: account.round,
        // Not opted in is an absence, not an empty state (§types.AlgodClient).
        state: entry === undefined ? null : decodeAppState(entry['key-value']),
      };
    },

    async getApplicationBox(appId: number, name: Uint8Array) {
      const encoded = encodeURIComponent(`b64:${Buffer.from(name).toString('base64')}`);
      const [status, box] = await Promise.all([
        http.getJson(`${root}/v2/status`),
        http.getJson(`${root}/v2/applications/${appId}/box?name=${encoded}`),
      ]);
      const parsed = z.object({ value: z.string() }).parse(box);
      return {
        round: StatusSchema.parse(status)['last-round'],
        value: Uint8Array.from(Buffer.from(parsed.value, 'base64')),
      };
    },
  };
}

/** The algod URL for an account read, for a `SourceRef` (§1.4). */
export function accountUrl(baseUrl: string, address: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v2/accounts/${address}`;
}
