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

  return project("algoterminal", {
    resources: [apiTestnet, Postgres, Redis, postgresVolume, redisVolume],
  });
});
