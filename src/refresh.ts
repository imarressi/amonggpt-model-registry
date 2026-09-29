/**
 * Daily refresh orchestrator.
 *
 *   pnpm refresh                                   live catalog, writes public/ + reports/
 *   pnpm refresh -- --catalog <file>               offline catalog (fixtures, CI for PRs)
 *   pnpm refresh -- --dry-run                      evaluate + validate, write nothing
 *
 * Failure rules: any fetch/parse/validation error exits non-zero BEFORE touching public/, so the
 * last valid publication survives. `latest.json` is only rewritten when the content hash changes;
 * `freshness.json` is rewritten on every successful run. Alerts land in reports/alerts.json and the
 * workflow turns them into a GitHub issue. Rollback = `git revert` of the publishing commit.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsExport from 'ajv-formats';

// ajv-formats ships CJS; under NodeNext the namespace type isn't callable even though the runtime export is
const addFormats = addFormatsExport as unknown as (ajv: Ajv2020) => void;
import { catalogById, fetchCatalog, readCatalogFile } from './catalog.js';
import { buildRoster, contentHash, diffAlerts } from './roster.js';
import { cheaperCandidates } from './select.js';
import type { Alert, ApprovedConfigs, BrandPolicy, Roster, SelectionPolicy } from './types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await readFile(p, 'utf8')) as T;
}

function parseArgs(argv: string[]): { catalogPath: string | null; dryRun: boolean } {
  let catalogPath: string | null = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--catalog') catalogPath = argv[++i] ?? null;
    else if (argv[i] === '--dry-run') dryRun = true;
  }
  return { catalogPath, dryRun };
}

export async function main(argv: string[]): Promise<number> {
  const { catalogPath, dryRun } = parseArgs(argv);
  const now = new Date();

  const { brands } = await readJson<{ brands: BrandPolicy[] }>(path.join(ROOT, 'policy/brands.json'));
  const approvedRaw = await readJson<Record<string, unknown>>(path.join(ROOT, 'policy/approved-configs.json'));
  delete approvedRaw['_comment'];
  const approved = approvedRaw as unknown as ApprovedConfigs;
  const policy = await readJson<SelectionPolicy>(path.join(ROOT, 'policy/selection.json'));
  const schema = await readJson<object>(path.join(ROOT, 'schemas/roster.schema.json'));

  // 1. catalog — a throw here publishes nothing
  const { models, checkedAt } = catalogPath
    ? await readCatalogFile(path.resolve(catalogPath))
    : await fetchCatalog();
  if (models.length < policy.catalog_min_models) {
    console.error(`abort: catalog has ${models.length} models, below the ${policy.catalog_min_models} floor — not publishing`);
    return 2;
  }

  const latestPath = path.join(ROOT, 'public/latest.json');
  const prev: Roster | null = existsSync(latestPath) ? await readJson<Roster>(latestPath) : null;
  if (prev && models.length < prev.catalog_model_count * policy.catalog_max_shrink_ratio) {
    console.error(
      `abort: catalog shrank ${prev.catalog_model_count} → ${models.length} (beyond the ${policy.catalog_max_shrink_ratio} ratio) — not publishing, investigate upstream`,
    );
    return 2;
  }

  // 2. build + gate
  const byId = catalogById(models);
  const { roster, alerts } = buildRoster(brands, approved, byId, models.length, policy, now, checkedAt);
  alerts.push(...diffAlerts(prev, roster, policy));

  // 3. schema validation — an invalid roster is never written
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(roster)) {
    console.error('abort: generated roster fails its own schema — not publishing');
    console.error(JSON.stringify(validate.errors, null, 2));
    return 2;
  }

  // 4. candidate report (informational, never a promotion)
  const candidates = brands.flatMap((b) => {
    const eco = approved[b.brand_id]?.economy;
    return cheaperCandidates(b, eco ? byId.get(eco.model_id) : undefined, models, policy, now);
  });

  const unchanged = prev !== null && contentHash(prev) === contentHash(roster);

  for (const a of alerts) console.error(`[${a.level}] ${a.code}: ${a.message}`);
  const active = roster.brands.flatMap((b) => Object.values(b.tracks)).filter((t) => t.status === 'active').length;
  console.log(
    `roster ${roster.registry_version}: ${active}/20 slots active, ${alerts.length} alerts, ${candidates.length} cheaper candidates${unchanged ? ' (content unchanged — latest.json untouched)' : ''}${dryRun ? ' [dry-run]' : ''}`,
  );

  if (dryRun) return 0;

  // 5. write — freshness + reports always, latest.json only on change
  await mkdir(path.join(ROOT, 'public'), { recursive: true });
  await mkdir(path.join(ROOT, 'reports'), { recursive: true });
  if (!unchanged) await writeFile(latestPath, JSON.stringify(roster, null, 2) + '\n');
  await writeFile(
    path.join(ROOT, 'public/freshness.json'),
    JSON.stringify(
      {
        checked_at: checkedAt,
        catalog_model_count: models.length,
        registry_version: unchanged && prev ? prev.registry_version : roster.registry_version,
        warn_after_hours: policy.freshness.warn_hours,
        block_after_hours: policy.freshness.block_hours,
      },
      null,
      2,
    ) + '\n',
  );
  await writeFile(path.join(ROOT, 'reports/candidates.json'), JSON.stringify({ generated_at: now.toISOString(), candidates }, null, 2) + '\n');
  await writeFile(path.join(ROOT, 'reports/alerts.json'), JSON.stringify({ generated_at: now.toISOString(), alerts }, null, 2) + '\n');
  return alerts.some((a: Alert) => a.level === 'error') ? 1 : 0;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error('refresh failed:', e instanceof Error ? e.message : e);
      process.exit(2);
    },
  );
}
