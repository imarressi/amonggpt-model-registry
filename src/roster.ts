/**
 * Assemble the published roster. `config_id` hashes model identity + generation settings + routing
 * policy (never prices or timestamps). `contentHash` ignores volatile timestamps so an unchanged
 * roster is a no-op publish; the git commit that lands `latest.json` is the canonical immutable pin.
 */
import { createHash } from 'node:crypto';
import { evaluateConfig } from './select.js';
import type {
  ApprovedConfigs,
  Alert,
  BrandPolicy,
  CatalogModel,
  Roster,
  RosterBrand,
  SelectionPolicy,
  Track,
  TrackEntry,
} from './types.js';

export const SCHEMA_VERSION = 1;
export const TRACKS: readonly Track[] = ['economy', 'flagship'];

export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function configId(modelId: string, requestParameters: unknown, providerPolicy: unknown): string {
  const canon = stableStringify({ model_id: modelId, request_parameters: requestParameters, provider_policy: providerPolicy });
  return createHash('sha256').update(canon).digest('hex').slice(0, 12);
}

const VOLATILE_KEYS = new Set(['generated_at', 'catalog_checked_at', 'checked_at', 'registry_version']);

function stripVolatile(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripVolatile);
  if (typeof v === 'object' && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (VOLATILE_KEYS.has(k)) continue;
      out[k] = stripVolatile(val);
    }
    return out;
  }
  return v;
}

/** hash of everything that matters to the game — timestamps excluded */
export function contentHash(roster: Roster): string {
  return createHash('sha256').update(stableStringify(stripVolatile(roster))).digest('hex');
}

export function buildRoster(
  brands: BrandPolicy[],
  approved: ApprovedConfigs,
  catalog: Map<string, CatalogModel>,
  catalogModelCount: number,
  policy: SelectionPolicy,
  now: Date,
  catalogCheckedAt: string,
): { roster: Roster; alerts: Alert[] } {
  const alerts: Alert[] = [];
  const nowIso = now.toISOString();

  const rosterBrands: RosterBrand[] = [...brands]
    .sort((a, b) => a.priority - b.priority)
    .map((brand) => {
      const tracks = {} as Record<Track, TrackEntry>;
      for (const track of TRACKS) {
        const config = approved[brand.brand_id]?.[track];
        if (!config) {
          tracks[track] = { status: 'unavailable', reason: 'no approved configuration for this brand and track' };
          continue;
        }
        const cid = configId(config.model_id, config.request_parameters, config.provider_policy);
        const gate = evaluateConfig(config, brand, track, catalog, policy, now);
        if (!gate.ok) {
          tracks[track] = {
            status: 'suspended',
            reason: gate.reasons.join('; '),
            model_id: config.model_id,
            config_id: cid,
          };
          alerts.push({
            level: 'error',
            code: 'slot-suspended',
            message: `${brand.brand_id}/${track} (${config.model_id}) suspended: ${gate.reasons.join('; ')}`,
          });
          continue;
        }
        const m = catalog.get(config.model_id)!;
        tracks[track] = {
          status: 'active',
          config_id: cid,
          model_id: config.model_id,
          canonical_slug: m.canonical_slug ?? null,
          display_name: m.name ?? null,
          request_parameters: config.request_parameters,
          provider_policy: config.provider_policy,
          pricing: {
            currency: 'USD',
            prompt_per_token: m.pricing?.['prompt'] ?? null,
            completion_per_token: m.pricing?.['completion'] ?? null,
            basis: 'catalog',
            checked_at: catalogCheckedAt,
          },
          context_length: m.context_length ?? null,
          expiration_date: m.expiration_date ?? null,
          validation: { status: 'static-checks', checked_at: nowIso },
          selection: { reason: config.reason, evidence: config.evidence },
        };
      }
      return { brand_id: brand.brand_id, display_name: brand.display_name, priority: brand.priority, tracks };
    });

  const roster: Roster = {
    schema_version: SCHEMA_VERSION,
    registry_version: 'pending',
    generated_at: nowIso,
    catalog_checked_at: catalogCheckedAt,
    catalog_model_count: catalogModelCount,
    default_track: 'economy',
    api: { provider: 'openrouter', base_url: 'https://openrouter.ai/api/v1', chat_path: '/chat/completions' },
    brands: rosterBrands,
  };
  roster.registry_version = `${nowIso.slice(0, 10)}-${contentHash(roster).slice(0, 7)}`;
  return { roster, alerts };
}

/** price-movement and status-change alerts vs the previously published roster */
export function diffAlerts(prev: Roster | null, next: Roster, policy: SelectionPolicy): Alert[] {
  if (!prev) return [];
  const alerts: Alert[] = [];
  const prevBrands = new Map(prev.brands.map((b) => [b.brand_id, b]));
  for (const b of next.brands) {
    const pb = prevBrands.get(b.brand_id);
    if (!pb) continue;
    for (const track of TRACKS) {
      const cur = b.tracks[track];
      const old = pb.tracks[track];
      if (!cur || !old) continue;
      if (old.status === 'active' && cur.status !== 'active') {
        alerts.push({
          level: 'error',
          code: 'slot-deactivated',
          message: `${b.brand_id}/${track} went ${old.status} → ${cur.status}${'reason' in cur ? `: ${cur.reason}` : ''}`,
        });
      }
      if (old.status === 'active' && cur.status === 'active') {
        for (const side of ['prompt_per_token', 'completion_per_token'] as const) {
          const a = Number(old.pricing[side]);
          const c = Number(cur.pricing[side]);
          if (Number.isFinite(a) && Number.isFinite(c) && a > 0 && c > 0) {
            const pct = (c / a - 1) * 100;
            if (Math.abs(pct) >= policy.price_change_alert_pct) {
              alerts.push({
                level: 'warning',
                code: 'price-change',
                message: `${b.brand_id}/${track} (${cur.model_id}) ${side} moved ${pct.toFixed(1)}%`,
              });
            }
          }
        }
        if (old.model_id !== cur.model_id) {
          alerts.push({
            level: 'warning',
            code: 'model-changed',
            message: `${b.brand_id}/${track} model changed ${old.model_id} → ${cur.model_id} (policy PR)`,
          });
        }
      }
    }
  }
  return alerts;
}
