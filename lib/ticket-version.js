// Versión de la solución (v1.19): en los tickets de las categorías técnicas que la piden (ej. Equis), en qué versión del
// sistema viene la solución. Se guarda siempre igual, "versión 11 2026", para que los filtros y los informes agrupen bien.
import { bad } from './http.js';

const RE = /^(?:versi[oó]n\s*)?v?\s*(\d{1,2})\s*[\s./-]\s*(\d{4})$/i;

/** "11/2026", "version 11 2026", "v 11-2026"… → "versión 11 2026". Vacío → null. Otra cosa → error claro. */
export function normalizeVersion(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(/\s+/g, ' ');
  if (!s) return null;
  const m = RE.exec(s);
  const n = m ? Number(m[1]) : 0;
  const y = m ? Number(m[2]) : 0;
  if (!m || n < 1 || y < 2000 || y > 2100) throw bad('La versión va con número y año, por ejemplo "versión 11 2026"');
  return `versión ${n} ${y}`;
}

/** Orden natural de las versiones (por año y número), para la lista y los informes. */
export const VERSION_SORT_SQL = `(coalesce(substring(t.version from '(\\d{4})$'), '0')::int * 100 + coalesce(substring(t.version from ' (\\d{1,2}) '), '0')::int)`;
