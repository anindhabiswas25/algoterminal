import { defineRailway, postgres, preserve, project, redis, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "iad" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const Redis = redis("Redis", { region: "iad" });
  Redis.deploy = { startCommand: "/bin/sh -c \"rm -rf $RAILWAY_VOLUME_MOUNT_PATH/lost+found/ && exec docker-entrypoint.sh redis-server --requirepass $REDIS_PASSWORD --save 60 1 --dir $RAILWAY_VOLUME_MOUNT_PATH\"" };
  Redis.networking = { privateNetworkEndpoint: "redis" };
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "iad", sizeMB: 500 });
  const redisVolume = volume("redis-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "iad", sizeMB: 500 });
  const apiTestnet = service("api-testnet", {
    replicas: { "iad": 1 },
    // Every variable `src/config/env.ts` reads must appear here, INCLUDING the
    // optional ones. A variable set in the dashboard but missing from this list
    // survives a deploy and is dropped by the next `railway config apply` — a
    // config that silently discards a secret is a trap that springs weeks later,
    // at the moment someone reconciles infrastructure. `ANTHROPIC_API_KEY` was
    // that trap (LAUNCH_LOG.md §4g item 4); it is preserved whether or not /ask
    // is ever enabled, because the point is the config, not the route.
    env: { ALGOD_URL: preserve(), ANTHROPIC_API_KEY: preserve(), DATABASE_URL: preserve(), INDEXER_URL: preserve(), LOG_LEVEL: preserve(), METHODOLOGY_VERSION: preserve(), NODE_ENV: preserve(), OWN_PAYER_ADDRESSES: preserve(), PORT: preserve(), PUBLIC_BASE_URL: preserve(), REDIS_URL: preserve(), TESTNET_BASE_URL: preserve(), X402_FACILITATOR_URL: preserve(), X402_NETWORK: preserve(), X402_PAYTO: preserve() },
  });
  apiTestnet.deploy = {
    // DEPLOYMENT.md §3: schema changes are applied by migration, never on boot.
    // A schema change is a deploy step with its own success and its own
    // rollback; folding it into `start` makes a schema change and a code change
    // succeed or fail as one unreviewable unit.
    //
    // `migrate:prod` runs `node dist/db/migrate-cli.js`, not `tsx`. The deploy
    // image is built with `--omit=dev`, so `tsx` is not in it — a `scripts/*.ts`
    // entrypoint would fail the deploy at exactly the step that exists to make
    // schema changes safe.
    preDeployCommand: ["npm run migrate:prod"],
    // /health is free and never gated (API_SPEC.md §1), so it is a liveness
    // probe rather than a payment path.
    healthcheckPath: "/health",
  };

  // The MainNet service. `DEPLOYMENT.md` §3: "Run two services from one repo:
  // `api` (mainnet) and `api-testnet` (testnet), differing only in
  // `X402_NETWORK` and `X402_PAYTO`." Everything else here is deliberately
  // identical to `api-testnet`, including the deploy config below.
  //
  // It SHARES the Postgres and Redis above rather than getting its own, and
  // that is a decision worth recording rather than inferring:
  //
  //  - `payments` carries a NOT NULL `network` column (migrations/002), so
  //    MainNet and TestNet settlements are distinguishable in one table. A
  //    shared ledger is queryable; two ledgers would have to be unioned by
  //    hand every time §7.2's compliance queries run.
  //  - The cache is network-INDEPENDENT by construction. `src/cache/keys.ts`
  //    keys on `{methodology_version, protocol, kpi, paramsHash}` and nothing
  //    else, because the connectors always read MainNet chain data whatever
  //    chain payments settle on (§3's corrected note). So both services cache
  //    the identical fact under the identical key, and MainNet starts warm
  //    instead of serving its first paid calls from a ~65 s upstream fetch.
  const api = service("api", {
    replicas: { "iad": 1 },
    env: { ALGOD_URL: preserve(), ANTHROPIC_API_KEY: preserve(), DATABASE_URL: preserve(), INDEXER_URL: preserve(), LOG_LEVEL: preserve(), METHODOLOGY_VERSION: preserve(), NODE_ENV: preserve(), OWN_PAYER_ADDRESSES: preserve(), PORT: preserve(), PUBLIC_BASE_URL: preserve(), REDIS_URL: preserve(), TESTNET_BASE_URL: preserve(), X402_FACILITATOR_URL: preserve(), X402_NETWORK: preserve(), X402_PAYTO: preserve() },
  });
  api.deploy = {
    preDeployCommand: ["npm run migrate:prod"],
    healthcheckPath: "/health",
  };

  return project("algoterminal", {
    resources: [api, apiTestnet, Postgres, Redis, postgresVolume, redisVolume],
  });
});
