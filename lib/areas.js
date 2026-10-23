// Área solicitante del ticket a partir del área del contacto (v1.12.1).
// El área del contacto es texto libre (la carga un agente o viene del "Departamento" del directorio de Microsoft 365).
// Se compara, sin mayúsculas, tildes ni signos, con el nombre, la descripción y los "otros nombres" de cada área solicitante.
import { q } from './db.js';

export const normArea = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Devuelve una función área del contacto → id del área solicitante (o null). */
export async function areaMatcher() {
  const cats = await q('select id, name, description, aliases from categories where active order by sort, id');
  const map = new Map();
  // El nombre gana sobre la descripción y los otros nombres (si dos áreas comparten un texto, queda la primera por orden)
  for (const pass of ['name', 'description', 'aliases']) {
    for (const c of cats) {
      const texts = pass === 'aliases' ? c.aliases || [] : [c[pass]];
      for (const x of texts) {
        const k = normArea(x);
        if (k && !map.has(k)) map.set(k, c.id);
      }
    }
  }
  return (area) => map.get(normArea(area)) ?? null;
}

/** Completa el área de los tickets que no la tienen, según el área de su contacto. Devuelve cuántos completó. */
export async function fillMissingAreas() {
  const match = await areaMatcher();
  const rows = await q(`select t.id, c.area from tickets t join contacts c on c.id=t.contact_id
    where t.category_id is null and t.deleted_at is null and coalesce(c.area,'') <> ''`);
  const byCat = new Map();
  for (const r of rows) {
    const id = match(r.area);
    if (id) byCat.set(id, [...(byCat.get(id) || []), r.id]);
  }
  let n = 0;
  for (const [cat, ids] of byCat) {
    const done = await q('update tickets set category_id=$1 where id = any($2::int[]) and category_id is null returning id', [cat, ids]);
    n += done.length;
  }
  return n;
}

/** Áreas de contactos que no coinciden con ninguna área solicitante (para asignarlas en Configuración). */
export async function unmatchedAreas() {
  const match = await areaMatcher();
  const rows = await q(`select c.area, count(distinct c.id)::int as contacts,
      count(t.id) filter (where t.category_id is null and t.deleted_at is null)::int as tickets
    from contacts c left join tickets t on t.contact_id=c.id
    where coalesce(c.area,'') <> '' group by c.area order by count(distinct c.id) desc, c.area`);
  const grouped = new Map();
  for (const r of rows) {
    if (match(r.area)) continue;
    const k = normArea(r.area);
    const g = grouped.get(k) || { area: r.area.trim(), contacts: 0, tickets: 0 };
    g.contacts += r.contacts;
    g.tickets += r.tickets;
    grouped.set(k, g);
  }
  return [...grouped.values()].slice(0, 200);
}
