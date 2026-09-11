// src/config/env.ts validates and exits at module load, so every test process
// needs a valid environment before any src/ module is imported.
process.env.NODE_ENV = 'test';
process.env.X402_NETWORK ??= 'testnet';
// A real, checksum-valid Algorand address. It must be: `X402_PAYTO` becomes the
// receiver of every payment transaction the gate's tests build, and algosdk
// rejects an address whose trailing checksum does not verify — which is exactly
// why `src/config/env.ts` validates the checksum too rather than only the
// alphabet.
process.env.X402_PAYTO ??= 'COMJM4YZ5PAFPG7AN3SMDGKQEBE3LPGIIQ4MLHYDEJVPX64E472UX6OYWY';
process.env.X402_FACILITATOR_URL ??= 'https://facilitator.goplausible.xyz';
process.env.ALGOD_URL ??= 'https://testnet-api.4160.nodely.dev';
process.env.INDEXER_URL ??= 'https://testnet-idx.4160.nodely.dev';
// Required since the cache landed (step 5). Format-validated at boot only —
// nothing here connects, because every cache test injects its own tier doubles
// and the two integration suites skip themselves when the servers are absent.
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.DATABASE_URL ??= 'postgres://localhost:5432/algoterminal_test';
// A deployment WITH /ask configured. Nothing reaches Anthropic in the suite —
// every test injects a scripted client via `setAskClient` — but `/ask` is only
// gated and advertised when a key is present (`gatedRoutes`), so a test process
// without one would be testing a deployment that does not sell the route.
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-not-a-real-key';
process.env.METHODOLOGY_VERSION ??= '1.2.0';
process.env.PUBLIC_BASE_URL ??= 'http://localhost:3000';
process.env.LOG_LEVEL ??= 'silent';
