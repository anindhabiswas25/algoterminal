/**
 * The service's response shapes, as TypeScript.
 *
 * Deliberately structural and permissive about additions: /catalog grows as
 * connectors are added and new KPIs appear, and a type that rejects an unknown
 * KPI id would turn a coverage expansion into a client-side outage. Nothing
 * here is validated against a hardcoded enum for that reason — the authority on
 * what exists is `GET /catalog`, read at runtime.
 */

export type Unit = 'USD' | 'RATIO' | 'COUNT' | 'ASSET_UNITS';
export type CacheState = 'hit' | 'miss' | 'stale';

export interface SourceRef {
  name: string;
  url?: string;
  kind?: string;
  retrieved_at?: string;
}

export interface Coverage {
  entities: number;
  excluded: number;
  basis: string;
}

export interface FactError {
  code: string;
  message: string;
}

export interface KpiFact {
  metric: string;
  protocol: string;
  value: number | null;
  unit: Unit | null;
  timestamp: string;
  as_of?: string;
  source?: SourceRef[];
  confidence: number;
  is_estimated?: boolean;
  estimation_method?: string | null;
  methodology_version: string;
  cache?: CacheState;
  stale?: boolean;
  coverage?: Coverage;
  notes?: string[];
  error?: FactError;
}

export interface RankingEntry {
  rank: number;
  protocol: string;
  value: number;
}

export interface Spread {
  max: number;
  min: number;
  ratio: number | null;
}

export interface Comparability {
  confidence: number;
  note: string;
  caveats: string[];
}

export interface CompareResponse {
  metric: string;
  unit: Unit;
  timestamp: string;
  methodology_version: string;
  facts: KpiFact[];
  ranking: RankingEntry[];
  ranking_basis: string;
  spread: Spread | null;
  comparability: Comparability;
  cache: CacheState;
  stale: boolean;
  partial: boolean;
  excluded_protocols: string[];
}

export interface Citation {
  claim?: string;
  fact_index?: number;
  [k: string]: unknown;
}

export interface AskResponse {
  question: string;
  answer: string;
  facts: KpiFact[];
  plan: unknown;
  citations: Citation[];
  confidence: number;
  caveats: string[];
  methodology_version: string;
  model: { router: string; synthesizer: string };
  timestamp: string;
  depth: 'standard' | 'deep';
  format: 'prose' | 'facts' | 'both';
  cache: CacheState;
}

export interface CatalogRoute {
  path: string;
  method: string;
  price_usdc: string;
  price_fresh_usdc?: string;
  price_active_users_usdc?: string;
  price_deep_usdc?: string;
  available: boolean;
}

export interface CatalogProtocol {
  id: string;
  name: string;
  class: string;
  kpis: string[];
  sources?: string[];
  /** KPI id -> the paragraph explaining why this protocol does not publish it. */
  declined?: Record<string, string>;
}

export interface CatalogPayment {
  protocol: string;
  version: number;
  scheme: string;
  asset: string;
  asset_symbol: string;
  decimals: number;
  network: string;
  facilitator: string;
  payTo: string;
  fee_sponsored: boolean;
}

export interface Catalog {
  service: string;
  methodology_version: string;
  network: string;
  payment: CatalogPayment;
  protocols: CatalogProtocol[];
  routes: CatalogRoute[];
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    detail?: Record<string, unknown>;
  };
}
