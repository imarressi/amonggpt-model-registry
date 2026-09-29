/** Shapes of the OpenRouter catalog (subset we read), policy files, and the published roster. */

export interface ReasoningInfo {
  mandatory?: boolean;
  default_enabled?: boolean;
  supported_efforts?: string[];
  default_effort?: string;
}

export interface CatalogModel {
  id: string;
  canonical_slug?: string;
  name?: string;
  created?: number;
  context_length?: number | null;
  pricing?: Record<string, string | null | undefined>;
  supported_parameters?: string[];
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
  reasoning?: ReasoningInfo | null;
  expiration_date?: string | null;
  top_provider?: {
    context_length?: number | null;
    max_completion_tokens?: number | null;
  } | null;
}

export interface BrandPolicy {
  brand_id: string;
  display_name: string;
  priority: number;
  authors: string[];
}

export interface ApprovedConfig {
  model_id: string;
  request_parameters: Record<string, unknown>;
  provider_policy: Record<string, unknown>;
  reason: string;
  evidence: string[];
  notes?: string;
  approved_at: string;
}

export type ApprovedConfigs = Record<
  string,
  { economy?: ApprovedConfig; flagship?: ApprovedConfig }
>;

export interface SelectionPolicy {
  game_contract: {
    min_context_length: number;
    min_completion_tokens: number;
    required_parameters: string[];
  };
  exclusions: { id_suffixes: string[]; id_substrings: string[] };
  expiry_horizon_days: number;
  price_ceilings_per_mtok: Record<Track, { prompt: number; completion: number }>;
  cost_model: { prompt_tokens_per_call: number; completion_tokens_per_call: number };
  catalog_min_models: number;
  catalog_max_shrink_ratio: number;
  price_change_alert_pct: number;
  freshness: { warn_hours: number; block_hours: number };
}

export type Track = 'economy' | 'flagship';
export type TrackStatus = 'active' | 'suspended' | 'unavailable';

export interface Pricing {
  currency: 'USD';
  /** decimal string, $ per token, straight from the catalog; null when unknown — never zero */
  prompt_per_token: string | null;
  completion_per_token: string | null;
  basis: 'catalog';
  checked_at: string;
}

export interface ActiveEntry {
  status: 'active';
  config_id: string;
  model_id: string;
  canonical_slug: string | null;
  display_name: string | null;
  request_parameters: Record<string, unknown>;
  provider_policy: Record<string, unknown>;
  pricing: Pricing;
  context_length: number | null;
  expiration_date: string | null;
  validation: { status: 'static-checks'; checked_at: string };
  selection: { reason: string; evidence: string[] };
}

export interface InactiveEntry {
  status: 'suspended' | 'unavailable';
  reason: string;
  /** present on suspended entries so the config can be re-activated without a policy change */
  model_id?: string;
  config_id?: string;
}

export type TrackEntry = ActiveEntry | InactiveEntry;

export interface RosterBrand {
  brand_id: string;
  display_name: string;
  priority: number;
  tracks: Record<Track, TrackEntry>;
}

export interface Roster {
  schema_version: number;
  registry_version: string;
  generated_at: string;
  catalog_checked_at: string;
  catalog_model_count: number;
  default_track: Track;
  api: { provider: 'openrouter'; base_url: string; chat_path: string };
  brands: RosterBrand[];
}

export interface Alert {
  level: 'warning' | 'error';
  code: string;
  message: string;
}

export interface Candidate {
  brand_id: string;
  model_id: string;
  prompt_per_mtok: number;
  completion_per_mtok: number;
  est_cost_per_call_usd: number;
  vs_economy_pct: number;
  context_length: number | null;
  note: string;
}
