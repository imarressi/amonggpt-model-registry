# amonggpt-model-registry

Daily-refreshed, versioned roster of OpenRouter models for [AmongGPT](https://github.com/imarressi):
which model represents each brand, its exact API id, approved generation settings, pricing, and
availability. The game backend fetches one JSON document, pins it per batch, and never changes a
competitor mid-batch.

No database, no service: GitHub Actions + JSON in git. Git history **is** the snapshot store —
every commit that touches `public/latest.json` is an immutable, hash-addressed roster version.

## Consuming

```
https://raw.githubusercontent.com/imarressi/amonggpt-model-registry/main/public/latest.json
https://raw.githubusercontent.com/imarressi/amonggpt-model-registry/main/public/freshness.json
```

Backend contract, per batch:

1. Fetch `latest.json`, validate `schema_version === 1` against `schemas/roster.schema.json`.
2. Check freshness (`freshness.json`): warn past 36 h, refuse new scored batches past 72 h.
3. Pick the requested track (`economy` is the default) and require the brand slots you need to be
   `active` **on that track only** — a flagship outage never blocks an economy batch.
4. Persist the full roster JSON + the commit SHA with the batch, and use that frozen copy for every
   game in the batch. To replay, fetch the file at that SHA.
5. Build requests from `model_id` + `request_parameters` only — allowlisted fields, never arbitrary
   JSON into the request body. Catalog prices are planning data; actual usage charges are
   authoritative.

## Tracks

- `economy` — default gameplay and large batches: cheapest approved, sufficiently capable model per
  brand. "Sufficiently capable" is a human judgment made in the approval PR, not an automated gate.
- `flagship` — headline evaluations: strongest approved model per brand. Economy is **not** claimed
  to be equivalent to flagship.

Slot statuses: `active`, `suspended` (approved but currently failing a gate — reason included),
`unavailable` (no approved config). A missing brand model is never substituted or invented.

## The game contract (why some famous models are absent)

The game forces **reasoning off** — the harness sends `reasoning: {enabled: false}` (Google's
off-position is `{effort: "minimal"}`) and budgets ~110 completion tokens per turn. Models whose
catalog entry says `reasoning.mandatory: true` without a supported minimal effort cannot honor that
and are ineligible: as of 2026-09 that excludes Claude Opus 5.5 / Sonnet 5.5 / Fable, Grok 4.5–4.7,
GLM-5.3, Qwen3.8-max, and Gemini 3.7+/3.8 (floor is `low`). GPT-6 models don't support
`temperature`; their configs omit it. `:free` and `:batch` variants are excluded.

## How refresh works

Daily at 08:17 UTC (best-effort) and on manual dispatch, `.github/workflows/refresh.yml`:

1. Fetches the catalog (no API key — the endpoint is unauthenticated) with timeout + retries.
2. Aborts **before writing anything** on fetch/parse errors, a catalog below 200 models, or a >50%
   shrink vs the last publication — the last valid roster stays live.
3. Re-evaluates every approved config against the gates in `src/select.ts` (id exists, brand
   mapping, context/completion limits, required params supported, reasoning off-able, price known
   and under the per-track ceiling, not expired within 14 days).
4. Validates the result against `schemas/roster.schema.json`; an invalid roster is never written.
5. Writes `public/latest.json` only when content (ignoring timestamps) changed;
   `public/freshness.json` and `reports/` on every successful run; commits and pushes.
6. Opens a GitHub issue for suspensions, ≥25% price moves, or refresh failure.

Metadata refresh is automatic. **Model promotion never is**: new cheaper models only appear in
`reports/candidates.json`, and changing a pick means a PR against
`policy/approved-configs.json` (CI validates it offline against a fixture, with no secrets).

## Operations

- **Approve/replace a model**: PR editing `policy/approved-configs.json` with reason + evidence.
  Keep the incumbent unless the challenger clearly earns the swap — no churn on version numbers.
- **Manual refresh**: Actions → refresh → Run workflow (or `pnpm refresh` locally).
- **Rollback**: `git revert` the refresh commit and push; `latest.json` repoints to the prior
  validated roster. Never rewrite history — pinned SHAs must stay fetchable.
- **Local dev**: `pnpm install`, `pnpm test`, `pnpm refresh:offline` (fixture, writes nothing),
  `pnpm refresh` (live catalog, writes `public/` + `reports/`).

## Scope

This repo owns **selection, configuration, and provenance**. The game backend owns inference, the
OpenRouter key, budget enforcement (reservation ledger lives there), retries, logging, and outcome
analysis. Stable model ids do not promise immutable weights — providers can update serving behavior
behind an unchanged id; scored comparisons should state the registry version they ran against.
