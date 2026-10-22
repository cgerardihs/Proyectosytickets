import { q, one } from './db.js';

const cache = new Map();
const TTL = 30_000;

export async function getSetting(key, fallback = null) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < TTL) return c.v;
  const row = await one('select value from app_settings where key=$1', [key]);
  const v = row ? row.value : fallback;
  cache.set(key, { v, t: Date.now() });
  return v;
}

/** Guarda un valor. Si onlyIfMissing, no pisa uno existente. */
export async function setSetting(key, value, onlyIfMissing = false) {
  if (onlyIfMissing) {
    await q('insert into app_settings(key,value) values ($1,$2::jsonb) on conflict (key) do nothing', [key, JSON.stringify(value)]);
  } else {
    await q(
      'insert into app_settings(key,value,updated_at) values ($1,$2::jsonb,now()) on conflict (key) do update set value=excluded.value, updated_at=now()',
      [key, JSON.stringify(value)],
    );
  }
  cache.delete(key);
}

export function clearSettingsCache() {
  cache.clear();
}
