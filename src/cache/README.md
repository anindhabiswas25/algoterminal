# The cache (`ARCHITECTURE.md` §4.5, §4.6, §6)

> "The cache is not an optimization; it is the business model." — §1.2

A `/metric` call sells for $0.005. A cold Tinyman fetch was measured at **~26 s**
and costs a few thousand upstream requests. There is no price at which the second
thing pays for the first, so the paid path must essentially never do it — and
when it must, it must still answer, correctly labelled, rather than time out.

## The tiers

| Tier | Store | TTL | Purpose |
|---|---|---|---|
| L0 | in-process `lru-cache`, 2k entries | min(60 s, registry TTL) | absorbs bursts, sub-ms, survives a Redis blip |
| L1 | Redis | per-KPI, from the §4 registry | shared across instances; the real hit source |
| L2 | Postgres `kpi_snapshots` | unbounded | last-known-good when Redis *and* upstream are gone |

Key: `kpi:v{methodology_version}:{protocol}:{kpi}:{paramsHash}`.

## What a caller can tell from the fact

| Path | `cache` | `stale` | confidence |
|---|---|---|---|
| L0 or fresh L1 | `hit` | `false` | as computed |
| expired L1, served while revalidating | `stale` | `true` | × 0.90 (§5 `stale_l1`) |
| full miss, we fetched | `miss` | `false` | as computed |
| L2 last-known-good | `stale` | `true` | × 0.70, floored at 0.40, `as_of` = snapshot time |

`DATA_SCHEMA.md` §1: a stale number must never masquerade as a fresh one.

## Four decisions worth knowing

**Facts are cached, not raw snapshots.** A snapshot is per-protocol while a TTL
is per-KPI (§6), so a snapshot-level entry would force one TTL on a `tvl` that
moves every 5 minutes and a `volume_24h` that moves every 10. One entry per fact
lets each expire on its own schedule.

**The stampede lock is held on the fetch group, not the fact key.** §4.5 says
"a lock per key", which closes the stampede for one KPI and leaves open the one
that hurts: `fetchRaw` is per-protocol, so 11 cold Tinyman KPIs under 11
uncontended locks are 11 concurrent full enumerations. Measured on a live soak,
that kept the fast refresh cycle at 257 s against its own 60 s interval and the
hit rate at 0.13. Locking `(protocol, basis, TTL class)` took the first cycle to
30 s. See `cycles.ts`.

**`computeFacts` returns only the KPIs that were requested.** `opts.kpis` scopes
the *fetch*, not the arithmetic: a TVL-only fetch produces a snapshot with no 24 h
flows in it, and `toFacts` will duly report `volume_24h: 0` — arithmetically
correct, and exactly the plausible-looking zero §1.5 forbids. That is also why
§4.6 has two refresh cycles rather than one.

**The freshness penalty is applied to the stamped confidence.** Every other §5
penalty is known at compute time; `stale_l1` and `l2_snapshot` describe how a
fact reached *this* caller, and the same stored bytes are a fresh hit for one
request and a stale serve for the next. See `applyServePenalty` in
`standardize/confidence.ts`.

## Measured, on live mainnet (2026-09-09)

| | |
|---|---|
| cold request (full upstream fetch) | 25.9 s |
| warm L0 | p50 0.0 ms, p95 0.2 ms |
| warm L1 (fresh process) | p50 0.5 ms, p95 0.7 ms |
| `PRD.md` §5.1 p95 target | 250 ms |
| 50 concurrent cold callers, one key | **1** upstream fetch |

From a **completely cold** cache, with the refresher running and 2 req/s of
uniform traffic across the 11-fact hot set (`scripts/cache-soak.ts`):

| t | `hit_rate_1h` | fast cycle | slow cycle |
|---|---|---|---|
| 0 s | 0.00 | — | — |
| 168 s | 0.34 | 38 s / 60 s | 167 s / 600 s |
| **375 s** | **0.70** | 15 s / 60 s | 167 s / 600 s |
| 586 s | 0.81 | 29 s / 60 s | 167 s / 600 s |

The trailing-hour window still contains the whole cold start at t+586 s, so the
steady-state rate is ~1.0; a warm restart holds 1.0 from the first sample.
Uniform traffic is the harshest realistic pattern — real traffic concentrates
on a few KPIs, so this understates the hit rate rather than flattering it.

A real Redis outage (`scripts/cache-redis-outage.ts`, which stops the server
underneath the process):

```
=== killing Redis (brew services stop redis) ===
  redis: down
  L0 (warm process)    cache=hit   stale=false confidence=0.7
  L2 (cold process)    cache=stale stale=true  confidence=0.49
  another KPI, L2      cache=stale stale=true  confidence=0.57
=== restarting Redis ===
  after recovery       cache=hit   stale=false confidence=0.7
```

## Scripts

| | |
|---|---|
| `npm run migrate` | apply `migrations/*.sql` |
| `npm run cache:bench` | cold/L0/L1 latency, the stampede, the degradation path |
| `scripts/cache-soak.ts` | refresher + traffic + `/health`, for the hit-rate curve |
| `scripts/cache-redis-outage.ts` | stops and restarts the real Redis server |

All three need Redis, Postgres and network.
