/** Fetch and sanity-check the OpenRouter catalog. Fetch errors throw; callers must never publish on a throw. */
import { readFile } from 'node:fs/promises';
import type { CatalogModel } from './types.js';

export const CATALOG_URL = 'https://openrouter.ai/api/v1/models';

export interface CatalogResult {
  models: CatalogModel[];
  checkedAt: string;
}

function assertCatalogShape(raw: unknown): CatalogModel[] {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { data?: unknown }).data)) {
    throw new Error('catalog response has no data array');
  }
  const data = (raw as { data: unknown[] }).data;
  for (const m of data) {
    if (typeof m !== 'object' || m === null || typeof (m as { id?: unknown }).id !== 'string') {
      throw new Error('catalog entry without a string id');
    }
  }
  return data as CatalogModel[];
}

export async function fetchCatalog(fetchImpl: typeof fetch = globalThis.fetch, timeoutMs = 30_000, retries = 2): Promise<CatalogResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(CATALOG_URL, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`catalog fetch: http ${r.status}`);
      const raw: unknown = await r.json();
      return { models: assertCatalogShape(raw), checkedAt: new Date().toISOString() };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
    } finally {
      clearTimeout(to);
    }
  }
  throw new Error(`catalog fetch failed after ${retries + 1} attempts: ${String(lastErr)}`);
}

export async function readCatalogFile(path: string): Promise<CatalogResult> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  return { models: assertCatalogShape(raw), checkedAt: new Date().toISOString() };
}

export function catalogById(models: CatalogModel[]): Map<string, CatalogModel> {
  return new Map(models.map((m) => [m.id, m]));
}
