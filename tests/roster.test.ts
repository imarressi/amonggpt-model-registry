import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsExport from 'ajv-formats';

const addFormats = addFormatsExport as unknown as (ajv: Ajv2020) => void;
import { catalogById } from '../src/catalog.js';
import { buildRoster, configId, contentHash, diffAlerts, TRACKS } from '../src/roster.js';
import { cheaperCandidates, evaluateConfig, reasoningCompatible } from '../src/select.js';
import type { ApprovedConfig, ApprovedConfigs, BrandPolicy, CatalogModel, Roster, SelectionPolicy } from '../src/types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = <T>(p: string): T => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8')) as T;

const brands = readJson<{ brands: BrandPolicy[] }>('policy/brands.json').brands;
const policy = readJson<SelectionPolicy>('policy/selection.json');
const approvedRaw = readJson<Record<string, unknown>>('policy/approved-configs.json');
delete approvedRaw['_comment'];
const approved = approvedRaw as unknown as ApprovedConfigs;
const fixture = readJson<{ data: CatalogModel[] }>('tests/fixtures/catalog.json').data;
const byId = catalogById(fixture);
const NOW = new Date('2026-09-29T08:17:00Z');
const CHECKED = '2026-09-29T08:16:00Z';

const build = (cat = byId, count = fixture.length, appr = approved) =>
  buildRoster(brands, appr, cat, count, policy, NOW, CHECKED);

describe('buildRoster against the catalog fixture', () => {
  const { roster, alerts } = build();

  it('publishes all 10 brands in priority order with both tracks', () => {
    expect(roster.brands.map((b) => b.brand_id)).toEqual([
      'openai', 'anthropic', 'google', 'xai', 'meta', 'deepseek', 'qwen', 'moonshot', 'zai', 'mistral',
    ]);
    for (const b of roster.brands) for (const t of TRACKS) expect(b.tracks[t]).toBeDefined();
  });

  it('every approved slot is active with catalog-verified data (no alerts)', () => {
    expect(alerts).toEqual([]);
    for (const b of roster.brands) {
      for (const t of TRACKS) {
        const e = b.tracks[t];
        expect(e.status, `${b.brand_id}/${t}`).toBe('active');
        if (e.status !== 'active') continue;
        expect(byId.has(e.model_id)).toBe(true);
        expect(e.pricing.prompt_per_token).not.toBeNull();
        expect(e.pricing.completion_per_token).not.toBeNull();
        expect(e.pricing.prompt_per_token).not.toBe('0');
      }
    }
  });

  it('validates against the published JSON schema', () => {
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(readJson<object>('schemas/roster.schema.json'));
    expect(validate(roster), JSON.stringify(validate.errors)).toBe(true);
  });

  it('registry_version embeds the content hash', () => {
    expect(roster.registry_version).toBe(`2026-09-29-${contentHash(roster).slice(0, 7)}`);
  });
});

describe('eligibility gates', () => {
  const xai = brands.find((b) => b.brand_id === 'xai')!;
  const google = brands.find((b) => b.brand_id === 'google')!;
  const zai = brands.find((b) => b.brand_id === 'zai')!;
  const cfg = (model_id: string, request_parameters: Record<string, unknown> = { reasoning: { enabled: false } }): ApprovedConfig => ({
    model_id, request_parameters, provider_policy: {}, reason: 't', evidence: [], approved_at: '2026-09-29',
  });

  it('rejects a model id that is not in the catalog', () => {
    const r = evaluateConfig(cfg('x-ai/grok-99'), xai, 'economy', byId, policy, NOW);
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toContain('not found');
  });

  it('rejects :free and :batch variants', () => {
    for (const id of ['google/gemma-4-31b-it:free', 'x-ai/grok-4.3:batch']) {
      const brand = id.startsWith('google') ? google : xai;
      const r = evaluateConfig(cfg(id), brand, 'economy', byId, policy, NOW);
      expect(r.ok, id).toBe(false);
      expect(r.reasons.join(), id).toContain('excluded id suffix');
    }
  });

  it('rejects an author outside the brand mapping', () => {
    const r = evaluateConfig(cfg('z-ai/glm-5'), xai, 'flagship', byId, policy, NOW);
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toContain('approved mapping');
  });

  it('rejects mandatory-reasoning models that cannot be disabled (glm-5.3-flash)', () => {
    const r = evaluateConfig(cfg('z-ai/glm-5.3-flash'), zai, 'economy', byId, policy, NOW);
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toContain('reasoning is mandatory');
  });

  it("accepts mandatory reasoning when the approved effort is supported (Google 'minimal')", () => {
    const r = evaluateConfig(
      cfg('google/gemini-3.6-flash', { temperature: 0.9, reasoning: { effort: 'minimal' } }),
      google, 'flagship', byId, policy, NOW,
    );
    expect(r.ok, r.reasons.join('; ')).toBe(true);
    expect(reasoningCompatible({ mandatory: true, supported_efforts: ['low'] }, { effort: 'minimal' }).ok).toBe(false);
  });

  it('rejects a model expiring within the horizon (qwen-plus-2025-07-28, 2026-10-09)', () => {
    const qwen = brands.find((b) => b.brand_id === 'qwen')!;
    const r = evaluateConfig(
      cfg('qwen/qwen-plus-2025-07-28', { temperature: 0.9 }),
      qwen, 'economy', byId, policy, NOW,
    );
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toContain('expires');
  });

  it('accepts a model whose expiry is beyond the horizon (gemini-2.5-flash-lite, 21 days out)', () => {
    const r = evaluateConfig(
      cfg('google/gemini-2.5-flash-lite', { temperature: 0.9, reasoning: { effort: 'minimal' } }),
      google, 'economy', byId, policy, NOW,
    );
    expect(r.reasons.join()).not.toContain('expires');
  });

  it('treats a zero or missing price as unknown, never free', () => {
    const m = structuredClone(byId.get('x-ai/grok-4.3')!);
    m.pricing = { prompt: '0', completion: undefined };
    const cat = new Map(byId);
    cat.set(m.id, m);
    const r = evaluateConfig(cfg('x-ai/grok-4.3', { temperature: 0.9, reasoning: { enabled: false } }), xai, 'economy', cat, policy, NOW);
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toContain('pricing unknown');
  });

  it('enforces the per-track price ceilings', () => {
    const r = evaluateConfig(
      cfg('anthropic/claude-opus-5', { temperature: 0.9, reasoning: { enabled: false } }),
      brands.find((b) => b.brand_id === 'anthropic')!, 'economy', byId, policy, NOW,
    );
    expect(r.ok).toBe(false); // $5/MTok prompt over the $1.50 economy ceiling
    expect(r.reasons.join()).toContain('ceiling');
  });
});

describe('slot degradation', () => {
  it('a vanished model suspends its slot with an alert; the rest stay active', () => {
    const cat = new Map(byId);
    cat.delete('moonshotai/kimi-k3');
    const { roster, alerts } = build(cat);
    const slot = roster.brands.find((b) => b.brand_id === 'moonshot')!.tracks.flagship;
    expect(slot.status).toBe('suspended');
    if (slot.status === 'suspended') expect(slot.reason).toContain('not found');
    expect(alerts.some((a) => a.code === 'slot-suspended' && a.message.includes('kimi-k3'))).toBe(true);
    expect(roster.brands.find((b) => b.brand_id === 'moonshot')!.tracks.economy.status).toBe('active');
  });

  it('a brand with no approved config is unavailable, never invented', () => {
    const appr = { ...approved };
    delete appr['mistral'];
    const { roster } = build(byId, fixture.length, appr);
    const b = roster.brands.find((x) => x.brand_id === 'mistral')!;
    expect(b.tracks.economy.status).toBe('unavailable');
    expect(b.tracks.flagship.status).toBe('unavailable');
  });
});

describe('versioning and diffing', () => {
  it('config_id is stable and changes only with identity/settings/routing', () => {
    const a = configId('x/y', { temperature: 0.9 }, { allow_fallbacks: true });
    expect(a).toBe(configId('x/y', { temperature: 0.9 }, { allow_fallbacks: true }));
    expect(a).not.toBe(configId('x/y', { temperature: 0.8 }, { allow_fallbacks: true }));
    expect(a).not.toBe(configId('x/z', { temperature: 0.9 }, { allow_fallbacks: true }));
  });

  it('contentHash ignores timestamps, so a same-content rebuild is a no-op', () => {
    const one = build().roster;
    const two = buildRoster(brands, approved, byId, fixture.length, policy, new Date('2026-09-30T08:17:00Z'), '2026-09-30T08:16:00Z').roster;
    expect(contentHash(one)).toBe(contentHash(two));
  });

  it('diffAlerts flags deactivations and ≥25% price moves', () => {
    const prev = build().roster;
    const cat = new Map(byId);
    const kimi = structuredClone(cat.get('moonshotai/kimi-k2.5')!);
    kimi.pricing = { ...kimi.pricing, prompt: String(Number(kimi.pricing!['prompt']) * 1.5) };
    cat.set(kimi.id, kimi);
    cat.delete('z-ai/glm-5');
    const next = build(cat).roster;
    const alerts = diffAlerts(prev, next, policy);
    expect(alerts.some((a) => a.code === 'slot-deactivated' && a.message.includes('zai/flagship'))).toBe(true);
    expect(alerts.some((a) => a.code === 'price-change' && a.message.includes('kimi-k2.5'))).toBe(true);
  });

  it('diffAlerts is quiet when nothing moved', () => {
    const r = build().roster;
    expect(diffAlerts(structuredClone(r) as Roster, r, policy)).toEqual([]);
  });
});

describe('candidate report', () => {
  it('surfaces cheaper eligible models without promoting them', () => {
    const openai = brands.find((b) => b.brand_id === 'openai')!;
    const eco = approved['openai']!.economy!;
    const cands = cheaperCandidates(openai, byId.get(eco.model_id), fixture, policy, NOW);
    for (const c of cands) {
      expect(c.model_id.startsWith('openai/')).toBe(true);
      expect(c.model_id.endsWith(':free')).toBe(false);
      expect(c.model_id.endsWith(':batch')).toBe(false);
      expect(c.est_cost_per_call_usd).toBeGreaterThan(0);
      expect(c.vs_economy_pct).toBeLessThan(0);
    }
  });
});
