import { describe, expect, it } from 'vitest';

import {
  KPI_IDS,
  KPI_REGISTRY,
  getKpi,
  isApplicable,
  isKpiId,
  listKpisForClass,
  ttlSecondsFor,
  type KpiId,
} from '../../src/standardize/kpis.js';
import { PROTOCOL_CLASSES, UNITS } from '../../src/standardize/types.js';

/**
 * The §4 table, transcribed independently of the registry so the test is a
 * second reading of the document rather than a restatement of the code.
 * ARCHITECTURE.md §6 is the authority on TTL; §4 repeats it, and the two agree.
 */
const SECTION_4_TABLE: ReadonlyArray<[KpiId, string, string[], number]> = [
  ['tvl', 'USD', ['dex', 'lending'], 300],
  ['volume_24h', 'USD', ['dex'], 600],
  ['gross_fees_24h', 'USD', ['dex', 'lending'], 600],
  ['supply_side_revenue_24h', 'USD', ['dex', 'lending'], 600],
  ['protocol_revenue_24h', 'USD', ['dex', 'lending'], 600],
  ['take_rate', 'RATIO', ['dex', 'lending'], 600],
  ['capital_efficiency', 'RATIO', ['dex', 'lending'], 600],
  ['fee_apr', 'RATIO', ['dex'], 600],
  ['volume_to_tvl', 'RATIO', ['dex'], 600],
  ['supply_apr', 'RATIO', ['lending'], 120],
  ['borrow_apr', 'RATIO', ['lending'], 120],
  ['utilization', 'RATIO', ['lending'], 120],
  ['total_borrows', 'USD', ['lending'], 300],
  ['active_users_24h', 'COUNT', ['dex', 'lending'], 900],
  ['pool_count', 'COUNT', ['dex', 'lending'], 900],
];

describe('KPI registry — DATA_SCHEMA.md §4', () => {
  it('has exactly the 15 KPIs of the §4 table, in table order', () => {
    expect(KPI_IDS).toEqual(SECTION_4_TABLE.map(([id]) => id));
    expect(KPI_IDS).toHaveLength(15);
  });

  it.each(SECTION_4_TABLE)('%s matches its §4 row', (id, unit, classes, ttl) => {
    const kpi = getKpi(id);
    expect(kpi.id).toBe(id);
    expect(kpi.unit).toBe(unit);
    expect([...kpi.applicableClasses]).toEqual(classes);
    expect(kpi.ttlSeconds).toBe(ttl);
    expect(kpi.description.length).toBeGreaterThan(0);
  });

  it.each(SECTION_4_TABLE)('%s ttlSeconds matches ARCHITECTURE.md §6', (id, _unit, _c, ttl) => {
    expect(ttlSecondsFor(id)).toBe(ttl);
  });

  it('uses only TTLs from the ARCHITECTURE.md §6 policy', () => {
    // §6 defines exactly four KPI TTL bands: 300s, 600s, 120s, 900s. A KPI on
    // some other number means someone invented a band without justifying it.
    const bands = new Set([120, 300, 600, 900]);
    for (const id of KPI_IDS) expect(bands.has(getKpi(id).ttlSeconds), id).toBe(true);
  });

  it('omits every §4.2 deferred KPI — absent means absent', () => {
    for (const deferred of ['p_f_ratio', 'p_s_ratio', 'market_cap', 'fdv', 'treasury']) {
      expect(isKpiId(deferred), `${deferred} is deferred to post-MVP by §4.2`).toBe(false);
    }
  });

  it('declares only §2.1 units and §2.2 classes', () => {
    for (const id of KPI_IDS) {
      const kpi = getKpi(id);
      expect(UNITS).toContain(kpi.unit);
      expect(kpi.applicableClasses.length).toBeGreaterThan(0);
      for (const c of kpi.applicableClasses) expect(PROTOCOL_CLASSES).toContain(c);
    }
  });

  it('carries take_rate’s "null if gross_fees < $1" rule as data, not as prose', () => {
    expect(KPI_REGISTRY.take_rate.nullWhen).toEqual({
      rule: 'gross_fees_24h < 1 USD',
      threshold: 1,
    });
  });

  it('carries active_users_24h’s 0.80 hard confidence cap as data (§4.1)', () => {
    expect(KPI_REGISTRY.active_users_24h.maxConfidence).toBe(0.8);
  });

  it('caps no other KPI — §4.1 is the only one', () => {
    const capped = KPI_IDS.filter((id) => getKpi(id).maxConfidence !== undefined);
    expect(capped).toEqual(['active_users_24h']);
  });
});

describe('isApplicable — §4, an inapplicable pair is a 404, never a zero', () => {
  it('is false for utilization on a dex', () => {
    expect(isApplicable('utilization', 'dex')).toBe(false);
  });

  it('is false for volume_24h on a lending protocol', () => {
    expect(isApplicable('volume_24h', 'lending')).toBe(false);
  });

  it('is true for the cross-class KPIs that make §3.2 worth doing', () => {
    for (const id of ['gross_fees_24h', 'protocol_revenue_24h', 'capital_efficiency'] as const) {
      expect(isApplicable(id, 'dex')).toBe(true);
      expect(isApplicable(id, 'lending')).toBe(true);
    }
  });

  it('is false for every KPI on l1, which has no v1 members', () => {
    for (const id of KPI_IDS) expect(isApplicable(id, 'l1'), id).toBe(false);
  });

  it('agrees with the §4 table for every (kpi, class) pair', () => {
    for (const [id, , classes] of SECTION_4_TABLE) {
      for (const c of PROTOCOL_CLASSES) {
        expect(isApplicable(id, c), `${id} x ${c}`).toBe(classes.includes(c));
      }
    }
  });
});

describe('listKpisForClass', () => {
  it('lists the 11 dex KPIs in §4 table order', () => {
    expect(listKpisForClass('dex').map((k) => k.id)).toEqual(
      SECTION_4_TABLE.filter(([, , c]) => c.includes('dex')).map(([id]) => id),
    );
  });

  it('lists the 12 lending KPIs in §4 table order', () => {
    expect(listKpisForClass('lending').map((k) => k.id)).toEqual(
      SECTION_4_TABLE.filter(([, , c]) => c.includes('lending')).map(([id]) => id),
    );
  });

  it('returns nothing for l1 (post-MVP)', () => {
    expect(listKpisForClass('l1')).toEqual([]);
  });

  it('agrees with isApplicable', () => {
    for (const c of PROTOCOL_CLASSES) {
      const listed = new Set(listKpisForClass(c).map((k) => k.id));
      for (const id of KPI_IDS) expect(listed.has(id)).toBe(isApplicable(id, c));
    }
  });
});
