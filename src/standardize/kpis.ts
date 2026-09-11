import { type ProtocolClass, type Unit } from './types.js';

/**
 * The KPI registry — DATA_SCHEMA.md §4, one entry per row of the table, as data
 * rather than as constants scattered across connectors and routes.
 *
 * `/catalog`, route validation, the cache TTL policy and the 404
 * `KPI_NOT_APPLICABLE` path all read from this one object. A KPI that is not in
 * here does not exist as far as the API is concerned — see §4.2 on why
 * `p_f_ratio`, `market_cap` and friends are deliberately absent from v1 rather
 * than present and half-considered.
 *
 * TTLs are cross-checked against ARCHITECTURE.md §6, which groups KPIs by how
 * fast the underlying number actually moves. §6 names 8 of the 15 explicitly;
 * the other 7 inherit the TTL of the class of number they are derived from
 * (24h-flow ratios track their 24h-flow inputs at 600s; `pool_count` tracks the
 * §3.6 filter pass at 900s). The two documents do not disagree anywhere.
 */
export interface KpiDefinition {
  /**
   * Stable KPI id, used in URLs and in `KpiFact.metric`. Typed `string` here
   * only because `KpiId` is derived *from* the registry below; every literal
   * id survives on {@link Kpi}, the type callers actually receive.
   */
  readonly id: string;
  /** §2.1 unit the value is emitted in. */
  readonly unit: Unit;
  /** §2.2 classes this KPI is defined for. Any other pairing is a 404. */
  readonly applicableClasses: readonly ProtocolClass[];
  /** Cache TTL in seconds — ARCHITECTURE.md §6. */
  readonly ttlSeconds: number;
  /** The §4 definition, verbatim enough to serve from `/catalog`. */
  readonly description: string;
  /**
   * A documented condition under which this KPI is `null` *by definition*
   * rather than by failure. Carried as data so the connector and the route
   * agree on it. §1.5: we decline loudly, we never return a plausible zero.
   */
  readonly nullWhen?: {
    readonly rule: string;
    /** The numeric threshold behind `rule`, so callers compare rather than parse. */
    readonly threshold: number;
  };
  /**
   * A ceiling this KPI's confidence can never exceed, whatever the derivation.
   * Enforced in `computeConfidence`, not by callers (CONNECTOR_GUIDE §4.4).
   */
  readonly maxConfidence?: number;
  /**
   * Why this KPI means the same thing across protocol classes — the §3.1/§3.2
   * sentence that licenses comparing a DEX against a lending market on it.
   *
   * Present on exactly the KPIs whose `applicableClasses` has more than one
   * entry, and required there: a KPI that spans classes without a stated basis
   * for spanning them is a comparison we have not justified. `/compare`
   * generates its cross-class caveat from this string (API_SPEC.md §3.2), so
   * the sentence a buyer reads is the one written next to the definition
   * rather than one composed in a route handler.
   *
   * Written as prose a careful analyst would sign: it names the mechanism, not
   * just the section number. "§3.1 says so" is not an argument a risk agent can
   * check; "swap fees paid by traders and interest paid by borrowers are both
   * what users pay to use the protocol" is.
   */
  readonly crossClassBasis?: string;
  /**
   * True when this KPI divides by a protocol's TVL (or, for `utilization`, by
   * its deposits) — so a difference in how the legs define that denominator
   * lands directly in the value.
   *
   * Carried as data because `/compare` needs it to tell two genuinely
   * different situations apart. When two legs report different
   * `coverage.basis` values, the consequence depends on whether the metric
   * touches the quantity the basis defines:
   *
   *  - `capital_efficiency` divides by TVL, and a DEX's TVL (liquidity in
   *    pools) and a lending market's (total deposits, including what is
   *    currently lent out) are different quantities. The gap between the legs
   *    is then partly definitional.
   *  - `take_rate` is `protocol_revenue / gross_fees`, both measured over the
   *    same entity set within each protocol. A basis difference changes WHICH
   *    entities each leg aggregated, but not what the ratio means — and saying
   *    "definitional gap" there would contradict the cross-class caveat, which
   *    correctly says the ratio is dimensionless and needs no conversion.
   *
   * Both facts deserve a caveat; they do not deserve the SAME caveat, and a
   * caller who reads the wrong one is worse off than one who reads none.
   */
  readonly tvlDenominated?: boolean;
}

/**
 * §4, in table order. `satisfies` keeps every entry checked against
 * `KpiDefinition` while preserving the literal `id`s that make up `KpiId`.
 */
export const KPI_REGISTRY = {
  tvl: {
    id: 'tvl',
    unit: 'USD',
    applicableClasses: ['dex', 'lending'],
    ttlSeconds: 300,
    description:
      'DEX: sum of pool liquidity. Lending: sum of total deposits (§3.5) — total value supplied, not deposits minus borrows.',
    crossClassBasis:
      'both are the capital the protocol has attracted and is holding — liquidity sitting in pools for a DEX, ' +
      'total deposits for a lending market (§3.5). The two are not identically constructed, though: a lending ' +
      "market's deposits include capital currently lent out, so check each leg's coverage.basis before reading a " +
      'difference as a difference in size',
  },
  volume_24h: {
    id: 'volume_24h',
    unit: 'USD',
    applicableClasses: ['dex'],
    ttlSeconds: 600,
    description: 'Sum of USD notional swapped, trailing 24h.',
  },
  gross_fees_24h: {
    id: 'gross_fees_24h',
    unit: 'USD',
    applicableClasses: ['dex', 'lending'],
    ttlSeconds: 600,
    description: 'Total paid by users to use the protocol, trailing 24h (§3.1).',
    crossClassBasis:
      '§3.1 defines gross_fees identically for both — swap fees paid by traders and interest paid by borrowers ' +
      'are both what users pay to use the protocol',
  },
  supply_side_revenue_24h: {
    id: 'supply_side_revenue_24h',
    unit: 'USD',
    applicableClasses: ['dex', 'lending'],
    ttlSeconds: 600,
    description: 'Portion of gross fees flowing to LPs / depositors (§3.1).',
    crossClassBasis:
      '§3.1 splits what users paid the same way for both — the share reaching the parties who supplied the ' +
      'capital, whether they are LPs earning a cut of swap fees or depositors earning borrower interest. ' +
      'Deposit interest is this quantity seen from the receiving end, never a second fee (§3.2)',
  },
  protocol_revenue_24h: {
    id: 'protocol_revenue_24h',
    unit: 'USD',
    applicableClasses: ['dex', 'lending'],
    ttlSeconds: 600,
    description: 'Portion of gross fees the protocol keeps (§3.1). The comparable "revenue".',
    crossClassBasis:
      '§3.1 defines protocol_revenue identically for both — the share of what users paid that the protocol ' +
      "itself keeps, whether that is a DEX's cut of the swap fee or a lending market's retention of borrower " +
      'interest. This is the figure comparable to a company\'s revenue, and it excludes token emissions, ' +
      'governance rewards and incentives on every class',
  },
  take_rate: {
    id: 'take_rate',
    unit: 'RATIO',
    applicableClasses: ['dex', 'lending'],
    ttlSeconds: 600,
    description: 'protocol_revenue_24h / gross_fees_24h.',
    // §4: "Null if gross_fees < $1." Below a dollar of fees the ratio is noise
    // divided by noise; emitting it would be the plausible-looking number §1.5
    // forbids.
    nullWhen: { rule: 'gross_fees_24h < 1 USD', threshold: 1 },
    crossClassBasis:
      'take_rate is protocol_revenue_24h / gross_fees_24h, and §3.1 defines both terms identically across ' +
      "classes, so the ratio is the protocol's cut of what its users paid either way. It is dimensionless, so " +
      'no unit or price conversion enters the comparison — which is why §3.1 calls it the clearest single ' +
      'demonstration that the standardization works',
  },
  capital_efficiency: {
    id: 'capital_efficiency',
    unit: 'RATIO',
    applicableClasses: ['dex', 'lending'],
    ttlSeconds: 600,
    description:
      '(gross_fees_24h * 365) / tvl — annualized fees generated per dollar of capital. The flagship cross-type ratio.',
    crossClassBasis:
      '§3.1 defines gross_fees identically for both — swap fees paid by traders and interest paid by borrowers ' +
      'are both what users pay to use the protocol',
    tvlDenominated: true,
  },
  fee_apr: {
    id: 'fee_apr',
    unit: 'RATIO',
    applicableClasses: ['dex'],
    ttlSeconds: 600,
    description:
      '(supply_side_revenue_24h * 365) / tvl — LP yield from fees only, incentives excluded (§3.1).',
    tvlDenominated: true,
  },
  volume_to_tvl: {
    id: 'volume_to_tvl',
    unit: 'RATIO',
    applicableClasses: ['dex'],
    ttlSeconds: 600,
    description: 'volume_24h / tvl — turnover. DEX-only by construction.',
    tvlDenominated: true,
  },
  supply_apr: {
    id: 'supply_apr',
    unit: 'RATIO',
    applicableClasses: ['lending'],
    ttlSeconds: 120,
    description: 'Deposit-weighted mean depositInterestRate.',
  },
  borrow_apr: {
    id: 'borrow_apr',
    unit: 'RATIO',
    applicableClasses: ['lending'],
    ttlSeconds: 120,
    description: 'Borrow-weighted mean variableBorrowInterestRate.',
  },
  utilization: {
    id: 'utilization',
    unit: 'RATIO',
    applicableClasses: ['lending'],
    ttlSeconds: 120,
    description: 'total_borrows_usd / total_deposits_usd, protocol-wide (§3.5).',
    // Divides by total deposits — the same quantity §3.5 defines lending TVL as.
    tvlDenominated: true,
  },
  total_borrows: {
    id: 'total_borrows',
    unit: 'USD',
    applicableClasses: ['lending'],
    ttlSeconds: 300,
    description: 'Sum of outstanding debt, USD.',
  },
  active_users_24h: {
    id: 'active_users_24h',
    unit: 'COUNT',
    applicableClasses: ['dex', 'lending'],
    ttlSeconds: 900,
    description:
      'Distinct Algorand addresses with at least one core protocol interaction in the trailing 24h (§4.1). Counts addresses, not humans.',
    crossClassBasis:
      '§4.1 counts the same event on both — a distinct address performing a core interaction, meaning a swap or ' +
      'a liquidity change on a DEX and a deposit, withdraw, borrow or repay on a lending market. The count is ' +
      'of addresses rather than people on every class, so the comparison inherits that limitation uniformly',
    // §4.1: capped at 0.80 "always, on every protocol". It is the least
    // reliable metric published, and is labeled as such rather than sitting
    // unmarked next to a TVL figure that is 20x more trustworthy.
    maxConfidence: 0.8,
  },
  pool_count: {
    id: 'pool_count',
    unit: 'COUNT',
    applicableClasses: ['dex', 'lending'],
    ttlSeconds: 900,
    description: 'Entities (pools / markets) passing the §3.6 inclusion filters.',
    crossClassBasis:
      'both count the venues that passed our inclusion filters. This is the weakest cross-class comparison we ' +
      'publish, and deliberately so: a DEX pool is permissionlessly created and filtered down from tens of ' +
      'thousands, while a lending market is listed by the protocol itself and takes no dust floor at all ' +
      '(§3.5). Comparable as a count of venues, not as a measure of size or activity',
  },
} as const satisfies Record<string, KpiDefinition>;

/** Every KPI id in v1. §4.2 KPIs are absent, and absent means absent. */
export type KpiId = keyof typeof KPI_REGISTRY;

/** A registry row, with its `id` narrowed to the union of real KPI ids. */
export type Kpi = KpiDefinition & { readonly id: KpiId };

/** §4 ids in table order — safe to iterate for `/catalog` and for tests. */
export const KPI_IDS = Object.keys(KPI_REGISTRY) as [KpiId, ...KpiId[]];

/** Type guard: is this arbitrary string a KPI we publish? */
export function isKpiId(id: string): id is KpiId {
  return Object.hasOwn(KPI_REGISTRY, id);
}

/** The §4 row for a KPI. Typed to `KpiId`, so an unknown id is a compile error. */
export function getKpi(id: KpiId): Kpi {
  return KPI_REGISTRY[id];
}

/**
 * Is this KPI defined for this protocol class? A `false` here is what produces
 * a 404 / `KPI_NOT_APPLICABLE` with `available_kpis`, never a zero (§1.5).
 */
export function isApplicable(kpiId: KpiId, protocolClass: ProtocolClass): boolean {
  const classes: readonly ProtocolClass[] = KPI_REGISTRY[kpiId].applicableClasses;
  return classes.includes(protocolClass);
}

/** Every KPI defined for a class, in §4 table order. Drives `available_kpis`. */
export function listKpisForClass(protocolClass: ProtocolClass): Kpi[] {
  return KPI_IDS.map((id): Kpi => KPI_REGISTRY[id]).filter((k) =>
    (k.applicableClasses as readonly ProtocolClass[]).includes(protocolClass),
  );
}

/**
 * The §3.1/§3.2 sentence licensing a cross-class comparison on this KPI.
 *
 * Throws for a KPI defined for only one class: there is no cross-class
 * comparison to license, and a caller asking for one has a bug. `/compare`
 * calls it only after establishing that its legs actually span classes.
 */
export function crossClassBasis(id: KpiId): string {
  const kpi = KPI_REGISTRY[id];
  if (kpi.applicableClasses.length < 2) {
    throw new RangeError(
      `"${id}" is defined for one class only (${kpi.applicableClasses.join(', ')}), so it has no cross-class basis`,
    );
  }
  // Unreachable while `assertRegistryCoherent` runs at import; the throw is
  // what makes that guarantee enforceable rather than assumed.
  const basis = (kpi as KpiDefinition).crossClassBasis;
  if (basis === undefined) throw new RangeError(`"${id}" spans classes with no stated crossClassBasis`);
  return basis;
}

/**
 * Every multi-class KPI states why it spans classes — checked at import.
 *
 * A KPI applicable to both `dex` and `lending` is a claim that a DEX and a
 * lending market can be ranked against each other on it, and that claim is the
 * entire product (§4: "it is only computable BECAUSE §3.2 made gross_fees mean
 * one thing across classes"). Adding a class to a row without writing the
 * sentence that justifies it would let `/compare` sell an unjustified
 * comparison with a caveat list that silently omits the one caveat that
 * matters, so it fails at import instead — the same fail-loud-at-boot rule the
 * connector registry follows.
 */
function assertRegistryCoherent(): void {
  const missing = KPI_IDS.filter(
    (id) =>
      KPI_REGISTRY[id].applicableClasses.length > 1 &&
      (KPI_REGISTRY[id] as KpiDefinition).crossClassBasis === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      `DATA_SCHEMA.md §4: these KPIs are defined for more than one protocol class but state no ` +
        `crossClassBasis, so /compare could not say why they are comparable: ${missing.join(', ')}`,
    );
  }
}

assertRegistryCoherent();

/** ARCHITECTURE.md §6 cache TTL for a KPI, in seconds. */
export function ttlSecondsFor(id: KpiId): number {
  return KPI_REGISTRY[id].ttlSeconds;
}
