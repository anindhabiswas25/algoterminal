-- 001_kpi_snapshots — the L2 cache tier (ARCHITECTURE.md §4.5, DEPLOYMENT.md §3).
--
-- DEPLOYMENT.md §3, minus `payments` (which arrives with the ledger at step
-- 11) and plus one column §3 did not have — see `params_hash` below.
--
-- This table is the last-known-good store the read path falls back to when
-- Redis and the upstream are both unavailable, and the backing store for
-- `/history` later.
--
-- A migration file rather than a CREATE TABLE on boot: two instances booting
-- concurrently against one database race on `IF NOT EXISTS`, and a schema that
-- only exists as a side effect of a successful boot cannot be reviewed in a
-- diff or rolled back independently of the deploy.

CREATE TABLE kpi_snapshots (
  id                  bigserial PRIMARY KEY,
  protocol            text NOT NULL,
  metric              text NOT NULL,
  value               double precision,
  unit                text,
  confidence          real,
  methodology_version text NOT NULL,
  as_of               timestamptz NOT NULL,
  fact                jsonb NOT NULL,

  -- NOT in DEPLOYMENT.md §3, and added here deliberately (§3 updated to match).
  --
  -- §3's key is UNIQUE (protocol, metric, as_of), which assumes one value per
  -- KPI per instant. That is false: DATA_SCHEMA.md §3.6 defines a `basis`, and
  -- `tinyman/tvl?basis=verified_only` and `?basis=all_pools_usd_priced` are two
  -- different numbers describing the same protocol at the same moment. Under
  -- §3's key the second one to arrive silently loses the ON CONFLICT race, and
  -- an L2 fallback would then answer a `verified_only` request with an
  -- all-pools figure — a wrong number wearing a correct envelope, which is the
  -- one failure DATA_SCHEMA.md §1 rules out. It is the same `paramsHash` that
  -- appears in the L1 key (src/cache/keys.ts), so the two tiers are keyed on
  -- the same identity.
  params_hash         text NOT NULL,

  UNIQUE (protocol, metric, params_hash, as_of)
);

-- The L2 read is "the newest snapshot for this identity, under the CURRENT
-- methodology version", so all four discriminators lead and `as_of DESC`
-- trails: the query is a descending index scan with LIMIT 1 rather than a sort
-- over the protocol's whole history.
--
-- `methodology_version` is in the predicate for the same reason it is in the
-- L1 cache key: a 1.0.0 snapshot is a different measurement from a 1.1.0 one,
-- and serving it to a 1.1.0 caller would put a pre-bump number behind
-- post-bump semantics. Old rows stay for `/history`; they are just not
-- reachable as a fallback for the running version.
CREATE INDEX ON kpi_snapshots (protocol, metric, params_hash, methodology_version, as_of DESC);
