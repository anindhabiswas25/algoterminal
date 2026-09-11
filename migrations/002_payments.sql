-- 002_payments — the x402 payment ledger (DEPLOYMENT.md §3, ARCHITECTURE.md §5.2).
--
-- Created at build step 6 rather than step 11, because the gate needs it on its
-- first request: the duplicate-txid guard (API_SPEC.md §2.4, 409
-- `payment_replayed`) reads it before verify, and the settle-failure row §5.2
-- requires is written from the settle path itself. A ledger that arrives after
-- the thing that must write to it is not a ledger.
--
-- TWO DELIBERATE DIVERGENCES from the §3 schema, in the same spirit as
-- `params_hash` in 001 (§3 updated to match):
--
-- 1. `payment_txid` is the primary key, not `txid`.
--
--    §3 keys the table on `txid`, the settlement transaction id. But §5.2
--    requires a row for a settle that FAILED after a successful handler — and a
--    failed settle has no settlement txid to key on. Under §3's key those rows
--    could not be written at all, which is precisely the silent revenue loss
--    §5.2 exists to make visible.
--
--    `payment_txid` is the id of the caller's own signed payment transaction,
--    computed from the `PAYMENT-SIGNATURE` payload before verify runs. It
--    exists for every payment we ever see, successful or not, which makes it
--    the only column that can be the identity of a payment. It is also what the
--    replay guard needs: the guard must answer "have I seen this payment
--    before?" BEFORE doing any work, and at that moment the settlement txid does
--    not exist yet.
--
-- 2. `payload` is new.
--
--    §5.2: "write a settle_failed ledger row WITH THE PAYMENT PAYLOAD for
--    reconciliation". Reconciling a failed settle by hand means re-submitting or
--    chasing the group on chain, and neither is possible from a txid we never
--    got. The payload is the only artifact that survives the failure.
--
-- `txid` (the settlement id, the one an operator pastes into an explorer) is
-- kept, nullable, and UNIQUE where present.

CREATE TABLE payments (
  -- Identity of the payment, derived locally from the client's signed payment
  -- transaction. Known before verify; present on every row including failures.
  payment_txid  text PRIMARY KEY,

  -- The settlement txid the facilitator returned. NULL on a `settle_failed`
  -- row, because there was no settlement. UNIQUE so a settlement can never be
  -- recorded against two payments.
  txid          text UNIQUE,

  payer         text NOT NULL,
  amount_atomic bigint NOT NULL,
  asset_id      bigint NOT NULL,
  route         text NOT NULL,
  network       text NOT NULL,
  settled_at    timestamptz NOT NULL DEFAULT now(),

  -- 'settled' | 'settle_failed' (ARCHITECTURE.md §5.2). Constrained rather than
  -- conventional: a typo'd status silently drops rows out of the /health
  -- settle-failure count, which is the one number that makes a settle outage
  -- visible.
  status        text NOT NULL CHECK (status IN ('settled', 'settle_failed')),

  -- The x402 payment payload, for reconciling a `settle_failed` row by hand.
  -- Null on a settled row: the settlement txid is the receipt there, and
  -- keeping the signed group for every successful payment stores a large blob
  -- nothing will ever read.
  payload       jsonb,

  -- The facilitator's reason, when it gave one. Read alongside `payload` during
  -- reconciliation; a settle-failure rate with no reasons attached tells an
  -- operator that something is wrong but not what.
  error_reason  text
);

CREATE INDEX ON payments (payer);
CREATE INDEX ON payments (settled_at);

-- /health's `facilitator.settle_failures_1h` and the §3.5 5-minute failure
-- rate are both "rows in a recent window, by status". Status leads so the
-- failure count is an index scan over the failures alone rather than over every
-- payment we have ever taken.
CREATE INDEX ON payments (status, settled_at DESC);
