/**
 * Eligibility gates. An approved config is only published as `active` when its exact model id is in
 * the live catalog and every gate passes; otherwise the slot is `suspended` with the reasons.
 * The gates encode the game contract from packages/harness: tiny completions, reasoning forced off
 * (Google's off-position is effort 'minimal'), no `:free` models.
 */
import type {
  ApprovedConfig,
  BrandPolicy,
  Candidate,
  CatalogModel,
  ReasoningInfo,
  SelectionPolicy,
  Track,
} from './types.js';

export interface GateResult {
  ok: boolean;
  reasons: string[];
}

function priceNum(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  // "0" on a paid model means the price is unknown, never that it is free
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function promptPrice(m: CatalogModel): number | null {
  return priceNum(m.pricing?.['prompt']);
}
export function completionPrice(m: CatalogModel): number | null {
  return priceNum(m.pricing?.['completion']);
}

function textOutput(m: CatalogModel): boolean {
  const a = m.architecture;
  if (!a) return true; // catalog omits architecture: assume chat, the smoke gate is the id existing
  if (Array.isArray(a.output_modalities)) return a.output_modalities.includes('text');
  if (typeof a.modality === 'string') return a.modality.endsWith('->text');
  return true;
}

/** reasoning must be off-able, or the approved config must pin an effort the model supports (Google 'minimal') */
export function reasoningCompatible(r: ReasoningInfo | null | undefined, approved: unknown): { ok: boolean; reason?: string } {
  if (!r) return { ok: true };
  if (!r.mandatory) return { ok: true };
  const effort =
    typeof approved === 'object' && approved !== null ? (approved as { effort?: unknown }).effort : undefined;
  if (typeof effort === 'string' && (r.supported_efforts ?? []).includes(effort)) return { ok: true };
  return {
    ok: false,
    reason: `reasoning is mandatory (supported efforts: ${(r.supported_efforts ?? []).join(', ') || 'unlisted'}) and the approved setting cannot disable it`,
  };
}

export function daysUntil(dateStr: string, now: Date): number {
  return (new Date(dateStr).getTime() - now.getTime()) / 86_400_000;
}

export function evaluateConfig(
  config: ApprovedConfig,
  brand: BrandPolicy,
  track: Track,
  catalog: Map<string, CatalogModel>,
  policy: SelectionPolicy,
  now: Date,
): GateResult {
  const reasons: string[] = [];
  const id = config.model_id;

  for (const suf of policy.exclusions.id_suffixes) {
    if (id.endsWith(suf)) reasons.push(`excluded id suffix ${suf}`);
  }
  for (const sub of policy.exclusions.id_substrings) {
    if (id.includes(sub)) reasons.push(`excluded id pattern ${sub}`);
  }
  const author = id.split('/')[0] ?? '';
  if (!brand.authors.includes(author)) {
    reasons.push(`author "${author}" is not in the approved mapping for ${brand.brand_id}`);
  }

  const m = catalog.get(id);
  if (!m) {
    reasons.push('model id not found in the current catalog');
    return { ok: false, reasons };
  }

  if (m.expiration_date) {
    const d = daysUntil(m.expiration_date, now);
    if (d <= policy.expiry_horizon_days) {
      reasons.push(`model expires ${m.expiration_date} (within the ${policy.expiry_horizon_days}-day horizon)`);
    }
  }

  if (!textOutput(m)) reasons.push('model does not output text');

  const ctx = m.context_length ?? null;
  if (ctx !== null && ctx < policy.game_contract.min_context_length) {
    reasons.push(`context ${ctx} < required ${policy.game_contract.min_context_length}`);
  }

  const maxOut = m.top_provider?.max_completion_tokens ?? null;
  if (maxOut !== null && maxOut < policy.game_contract.min_completion_tokens) {
    reasons.push(`max completion ${maxOut} < required ${policy.game_contract.min_completion_tokens}`);
  }

  const sp = m.supported_parameters ?? [];
  if (sp.length > 0) {
    for (const p of policy.game_contract.required_parameters) {
      if (!sp.includes(p)) reasons.push(`required parameter "${p}" unsupported`);
    }
    for (const key of Object.keys(config.request_parameters)) {
      if (!sp.includes(key)) reasons.push(`approved request parameter "${key}" unsupported by the model`);
    }
  }

  const rc = reasoningCompatible(m.reasoning, config.request_parameters['reasoning']);
  if (!rc.ok && rc.reason) reasons.push(rc.reason);

  const pin = promptPrice(m);
  const pout = completionPrice(m);
  if (pin === null || pout === null) {
    reasons.push('pricing unknown (missing or zero in the catalog)');
  } else {
    const ceiling = policy.price_ceilings_per_mtok[track];
    if (pin * 1e6 > ceiling.prompt) reasons.push(`prompt price $${(pin * 1e6).toFixed(3)}/MTok exceeds the ${track} ceiling $${ceiling.prompt}/MTok`);
    if (pout * 1e6 > ceiling.completion) reasons.push(`completion price $${(pout * 1e6).toFixed(3)}/MTok exceeds the ${track} ceiling $${ceiling.completion}/MTok`);
  }

  return { ok: reasons.length === 0, reasons };
}

/** estimated $ per game call under the cost model — reporting only, never billing */
export function estCostPerCall(m: CatalogModel, policy: SelectionPolicy): number | null {
  const pin = promptPrice(m);
  const pout = completionPrice(m);
  if (pin === null || pout === null) return null;
  const c = policy.cost_model;
  return pin * c.prompt_tokens_per_call + pout * c.completion_tokens_per_call;
}

/** catalog models by this brand's authors that would undercut the current economy pick */
export function cheaperCandidates(
  brand: BrandPolicy,
  economyModel: CatalogModel | undefined,
  catalog: CatalogModel[],
  policy: SelectionPolicy,
  now: Date,
): Candidate[] {
  const baseline = economyModel ? estCostPerCall(economyModel, policy) : null;
  if (baseline === null) return [];
  const out: Candidate[] = [];
  for (const m of catalog) {
    const author = m.id.split('/')[0] ?? '';
    if (!brand.authors.includes(author)) continue;
    if (m.id === economyModel?.id) continue;
    if (policy.exclusions.id_suffixes.some((s) => m.id.endsWith(s))) continue;
    if (policy.exclusions.id_substrings.some((s) => m.id.includes(s))) continue;
    if (m.expiration_date && daysUntil(m.expiration_date, now) <= policy.expiry_horizon_days) continue;
    if (!textOutput(m)) continue;
    if ((m.context_length ?? 0) < policy.game_contract.min_context_length) continue;
    if (m.reasoning?.mandatory && !(m.reasoning.supported_efforts ?? []).includes('minimal')) continue;
    const cost = estCostPerCall(m, policy);
    if (cost === null || cost >= baseline) continue;
    out.push({
      brand_id: brand.brand_id,
      model_id: m.id,
      prompt_per_mtok: (promptPrice(m) ?? 0) * 1e6,
      completion_per_mtok: (completionPrice(m) ?? 0) * 1e6,
      est_cost_per_call_usd: cost,
      vs_economy_pct: Math.round((cost / baseline - 1) * 100),
      context_length: m.context_length ?? null,
      note: 'cheaper than the current economy pick; not promoted — requires review and a policy PR',
    });
  }
  out.sort((a, b) => a.est_cost_per_call_usd - b.est_cost_per_call_usd);
  return out;
}
