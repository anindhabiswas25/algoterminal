/**
 * The spend ledger.
 *
 * An agent in a loop is the threat model. A model that decides to "check every
 * KPI for every protocol" makes 29 paid calls without pausing, and a model that
 * retries on a timeout it misread makes them again. Two caps bound that:
 *
 *  - **per-call** — refuses one call that costs more than the user agreed any
 *    single call may cost. Catches the expensive tier by accident: `fresh=true`
 *    on /compare is 16x the price of a cached /metric.
 *  - **session** — refuses the Nth call once the total is spent. Catches the
 *    loop, which no per-call cap can.
 *
 * Two properties matter more than the caps themselves:
 *
 *  1. **Refuse, never truncate.** There is no "spend what is left" path. A call
 *     that would exceed a cap does not happen, and the tool says why, in a
 *     sentence a model can relay to a human who can then raise the cap.
 *  2. **Record settlement, not intent.** `record` is called from the x402
 *     settlement hook, when the facilitator confirms a transaction. AlgoTerminal
 *     settles only after a 2xx, so an error costs the user nothing — and this
 *     ledger has to agree with the chain about that, or the counter it reports
 *     is fiction.
 *
 * All arithmetic is `bigint` atomic USDC (6dp). Floats do not belong in a
 * money counter; `0.005 * 3` is not `0.015` in IEEE 754.
 */
import { atomicToUsdc } from './config.js';

export interface Settlement {
  /** What the tool call was, for the receipt list. */
  readonly label: string;
  readonly atomic: bigint;
  /**
   * Algorand transaction id of the settled payment, or null when the service
   * returned data without a settlement receipt. The spend is still recorded in
   * that case — a 2xx on a paid route means the payment settled — but the
   * receipt says plainly that there is no txid to check it against.
   */
  readonly txid: string | null;
  readonly at: string;
}

export interface SpendSummary {
  readonly spentUsdc: string;
  readonly sessionCapUsdc: string;
  readonly remainingUsdc: string;
  readonly perCallCapUsdc: string;
  readonly settlements: readonly Settlement[];
  readonly callCount: number;
}

/** Thrown before any network request. Nothing was spent and nothing was attempted. */
export class SpendLimitError extends Error {
  constructor(
    message: string,
    readonly kind: 'per_call' | 'session',
    readonly quotedAtomic: bigint,
  ) {
    super(message);
    this.name = 'SpendLimitError';
  }
}

export class SpendLedger {
  #spent = 0n;
  readonly #settlements: Settlement[] = [];

  constructor(
    readonly sessionCapAtomic: bigint,
    readonly perCallCapAtomic: bigint,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get spentAtomic(): bigint {
    return this.#spent;
  }

  get remainingAtomic(): bigint {
    const left = this.sessionCapAtomic - this.#spent;
    return left > 0n ? left : 0n;
  }

  /**
   * Throws `SpendLimitError` if a payment of `quoted` may not be made.
   *
   * `quoted` must be the amount from the server's own 402, not a price read out
   * of a catalogue or a tool description. Those are advisory; the 402 is the
   * bill. Checking anything else means the cap guards a number the user is not
   * actually being charged.
   */
  assertAllowed(quotedAtomic: bigint, label: string): void {
    if (quotedAtomic > this.perCallCapAtomic) {
      throw new SpendLimitError(
        `REFUSED: ${label} costs ${atomicToUsdc(quotedAtomic)} USDC, above the per-call cap of ` +
          `${atomicToUsdc(this.perCallCapAtomic)} USDC. Nothing was spent and no request was paid for. ` +
          'To allow it, raise ALGOTERMINAL_MAX_PER_CALL_USDC in the MCP server config and restart. ' +
          'Do not retry this call as-is; it will be refused identically.',
        'per_call',
        quotedAtomic,
      );
    }

    if (this.#spent + quotedAtomic > this.sessionCapAtomic) {
      throw new SpendLimitError(
        `REFUSED: ${label} costs ${atomicToUsdc(quotedAtomic)} USDC, but only ` +
          `${atomicToUsdc(this.remainingAtomic)} USDC remains of this session's ` +
          `${atomicToUsdc(this.sessionCapAtomic)} USDC budget ` +
          `(${atomicToUsdc(this.#spent)} USDC already spent across ${this.#settlements.length} paid call(s)). ` +
          'Nothing was spent and no request was paid for. To continue, raise ALGOTERMINAL_MAX_SPEND_USDC ' +
          'in the MCP server config and restart the server. Do not retry this call as-is.',
        'session',
        quotedAtomic,
      );
    }
  }

  /** Record a payment the facilitator actually settled. */
  record(label: string, atomic: bigint, txid: string | null): Settlement {
    const settlement: Settlement = {
      label,
      atomic,
      txid,
      at: this.now().toISOString(),
    };
    this.#spent += atomic;
    this.#settlements.push(settlement);
    return settlement;
  }

  summary(): SpendSummary {
    return {
      spentUsdc: atomicToUsdc(this.#spent),
      sessionCapUsdc: atomicToUsdc(this.sessionCapAtomic),
      remainingUsdc: atomicToUsdc(this.remainingAtomic),
      perCallCapUsdc: atomicToUsdc(this.perCallCapAtomic),
      settlements: [...this.#settlements],
      callCount: this.#settlements.length,
    };
  }

  /** The line every paid tool result ends with. */
  render(): string {
    return (
      `SESSION SPEND: ${atomicToUsdc(this.#spent)} USDC of ${atomicToUsdc(this.sessionCapAtomic)} cap ` +
      `(${atomicToUsdc(this.remainingAtomic)} remaining, ${this.#settlements.length} paid call(s) this session).`
    );
  }
}
