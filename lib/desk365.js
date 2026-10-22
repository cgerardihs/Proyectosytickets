// Importación de tickets exportados de Desk365 (CSV o Excel, en español o en inglés).
// Conserva el número del ticket, la descripción, el estado, la prioridad, el grupo, el agente, el área, el tipo y las fechas.
// La exportación de Desk365 no trae las respuestas ni las notas: se deja una nota interna con la cantidad de conversaciones.
import { q, one } from './db.js';
import { norm, fuzzyMatch, matchUser } from './portfolio.js';
import { upsertContact, textToHtml } from './tickets-core.js';
import { escapeHtml } from './mail.js';
import { isEmail } from './http.js';
import { getSetting } from './settings.js';

/**
 * Grupo (de Desk365 o de versiones anteriores) → categoría técnica: primero lo que se eligió a mano en
 * Configuración → Campos del ticket; si no, por nombre (ej. "EQUIS - DESARROLLOS - …" → "Equis").
 * La subcategoría se toma si su nombre aparece en el del grupo.
 */
export function groupToTech(groupName, { techs, subs = [], groupMap = {} }) {
  const saved = groupMap?.[norm(groupName)];
  let tech = saved ? techs.find((t) => t.id === Number(saved.tech_category_id)) : null;
  let sub = saved?.tech_subcategory_id ? subs.find((x) => x.id === Number(saved.tech_subcategory_id)) : null;
  if (!tech) {
    // Mismo criterio que la migración 12: activas primero; igual nombre o comienzo del nombre hasta un límite de palabra; la más larga
    const g = norm(groupName);
    const active = techs.filter((t) => t.active !== false);
    const starts = (a, b) => a === b || a.startsWith(`${b} `);
    const cands = active.filter((t) => { const n = norm(t.name); return n.length >= 3 && (starts(g, n) || starts(n, g)); })
      .sort((a, b) => (norm(b.name) === g) - (norm(a.name) === g) || norm(b.name).length - norm(a.name).length);
    tech = cands[0] || fuzzyMatch(groupName, active);
    sub = tech ? subs.filter((x) => x.tech_category_id === tech.id && norm(x.name) && g.includes(norm(x.name))).sort((a, b) => b.name.length - a.name.length)[0] || null : null;
  }
  return tech ? { id: tech.id, name: tech.name, sub: sub && sub.tech_category_id === tech.id ? { id: sub.id, name: sub.name } : null } : null;
}

export const PLACEHOLDER_EMAIL = 'solicitante-sin-datos@desk365.invalid';

const HEADERS = [
  ['number', ['numero de ticket', 'n de ticket', 'ticket number', 'ticket id', 'id del ticket', 'numero']],
  ['subject', ['asunto', 'subject']],
  ['description', ['descripcion', 'description']],
  ['status', ['estado', 'status']],
  ['priority', ['prioridad', 'priority']],
  ['source', ['origen', 'source', 'canal']],
  ['type', ['tipo', 'type']],
  ['category', ['categoria', 'category']],
  ['subcategory', ['subcategoria', 'sub category', 'subcategory']],
  ['tech', ['categoria tecnica']],
  ['agent', ['asignar a', 'asignado a', 'agente', 'assign to', 'assigned to', 'agent']],
  ['group', ['grupo', 'group']],
  ['created', ['hora de creacion', 'fecha de creacion', 'created time', 'created on', 'created']],
  ['resolved', ['hora de resolucion', 'fecha de resolucion', 'resolved time', 'resolved on']],
  ['closed', ['hora de cierre', 'fecha de cierre', 'closed time', 'closed on']],
  ['updated', ['hora de actualizacion', 'fecha de actualizacion', 'updated time', 'updated on', 'last updated']],
  ['updated_by', ['actualizado por', 'updated by']],
  ['updated_by_type', ['tipo de actualizacion por', 'updated by type']],
  ['first_response', ['hora de primera respuesta', 'first response time', 'first responded']],
  ['time_total', ['tiempo total', 'total time']],
  ['conversations', ['numero de conversaciones', 'conversations', 'number of conversations']],
  ['contact_email', ['correo del contacto', 'correo electronico del contacto', 'email del contacto', 'contact email', 'correo electronico', 'email', 'correo']],
  ['contact_name', ['nombre del contacto', 'nombre de contacto', 'contact name', 'contacto', 'solicitante', 'nombre']],
  ['company', ['empresa', 'compania', 'company']],
  ['phone', ['telefono', 'phone']],
  ['cc', ['cc', 'en copia']],
  ['tags', ['etiquetas', 'tags']],
  ['sla', ['sla']],
];

/** Encabezados → columna. Exactos primero; después por prefijo (sin pisar columnas ya asignadas). */
export function mapDeskHeaders(row) {
  const map = {};
  const cells = (row || []).map((c) => norm(c).replace(/\s*\(.*\)$/, '').trim());
  for (const exact of [true, false]) {
    cells.forEach((h, i) => {
      if (!h || Object.values(map).includes(i)) return;
      for (const [field, names] of HEADERS) {
        if (map[field] !== undefined) continue;
        if (names.some((n) => (exact ? h === n : h.startsWith(n)))) { map[field] = i; break; }
      }
    });
  }
  return map;
}

/** "13/10/2026 01:17 PM" (hora de Buenos Aires) → ISO. También acepta 24 h, AAAA-MM-DD y fechas de Excel. */
export function parseDeskDate(v, tz = '-03:00') {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object' && v.date) return `${v.date}T12:00:00${tz}`;
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000)).toISOString();
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?\s*[Mm]\.?)?)?$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    let h = Number(m[4] || 0);
    const ap = (m[7] || '').replace(/[.\s]/g, '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    const iso = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T${String(h).padStart(2, '0')}:${m[5] || '00'}:${m[6] || '00'}${tz}`;
    const t = new Date(iso);
    return Number.isNaN(t.getTime()) || t.getUTCFullYear() < 2000 || t.getUTCFullYear() > 2100 || Number(m[2]) > 12 || Number(m[1]) > 31 ? null : t.toISOString();
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const t = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4] || '12'}:${m[5] || '00'}:${m[6] || '00'}${tz}`);
    return Number.isNaN(t.getTime()) ? null : t.toISOString();
  }
  return null;
}

/** Desk365 a veces exporta los textos con un par de comillas de más. */
const unquote = (s) => {
  const t = String(s ?? '').trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/""/g, '"').trim() : t;
};

const STATUS_KIND = [
  ['closed', ['cerrad', 'closed']],
  ['resolved', ['resuelt', 'resolved', 'solucionad']],
  ['pending', ['pendient', 'pending', 'en espera', 'on hold', 'waiting', 'stdby', 'standby', 'stand by']],
  ['open', ['abiert', 'open', 'nuevo', 'new', 'en curso', 'in progress']],
];
const PRIORITY = [[4, ['urgent', 'critic']], [3, ['alta', 'high']], [2, ['media', 'medium', 'normal']], [1, ['baja', 'low']]];
const CHANNEL = [['teams', ['teams']], ['email', ['correo', 'email', 'mail']], ['portal', ['portal', 'formulario', 'web', 'form']], ['phone', ['telef', 'phone', 'llamada']], ['chat', ['chat', 'whatsapp']], ['agent', ['agente', 'agent']]];
const TYPE_ALIASES = { request: 'Solicitud', 'service request': 'Solicitud', incident: 'Incidente', question: 'Consulta', issue: 'Problema', problem: 'Problema', 'feature request': 'Mejora / Desarrollo', bug: 'Problema' };
const pick = (text, table, fallback = null) => {
  const n = norm(text);
  if (!n) return fallback;
  for (const [k, words] of table) if (words.some((w) => n.includes(w))) return k;
  return fallback;
};

/**
 * Arma el plan de importación sin escribir nada. Cada fila dice si crea, actualiza (ya importada antes) u omite.
 * canCreate: el que importa es administrador (puede crear tipos o áreas que falten).
 */
export async function planDesk365(matrix, { canCreate = false } = {}) {
  const headerIdx = matrix.findIndex((r) => { const m = mapDeskHeaders(r); return m.number !== undefined && m.subject !== undefined; });
  if (headerIdx < 0) throw new Error('No reconozco el archivo: tiene que ser la exportación de tickets de Desk365, con las columnas "Número de ticket" y "Asunto".');
  const map = mapDeskHeaders(matrix[headerIdx]);
  const [statuses, groupMap, cats, types, techs, subs, users, contacts, existing] = await Promise.all([
    q('select id,name,kind,active,is_default,sort from statuses order by sort, id'),
    getSetting('group_to_tech', {}),
    q('select id,name,description from categories'),
    q('select id,name from ticket_types'),
    q('select id,name,active from tech_categories'),
    q('select id,name,tech_category_id,active from tech_subcategories'),
    q(`select id,name,email,active from users where role<>'superadmin'`),
    q('select id,name,email from contacts'),
    q(`select number, (custom ? 'desk365') as imported from tickets`),
  ]);
  const byNumber = new Map(existing.map((t) => [t.number, t]));
  const cell = (r, f) => (map[f] === undefined ? '' : r[map[f]] ?? '');
  const str = (x) => unquote(typeof x === 'object' && x ? x.date || '' : x);
  const contactByName = (name) => {
    const n = norm(name);
    if (!n) return null;
    const hits = contacts.filter((c) => norm(c.name) === n);
    return hits.length === 1 ? hits[0] : null;
  };
  const toCreate = { type: new Map(), area: new Map() };
  const rows = [];
  const seen = new Set();
  for (let i = headerIdx + 1; i < matrix.length && rows.length < 5000; i++) {
    const r = matrix[i] || [];
    const number = Number(String(cell(r, 'number')).replace(/[^\d]/g, ''));
    const subject = str(cell(r, 'subject')).replace(/\s+/g, ' ').slice(0, 300);
    if (!number && !subject) continue;
    const warnings = [];
    if (!Number.isInteger(number) || number < 1 || number > 2147483647) { rows.push({ row: i + 1, number: null, subject, action: 'skip', warnings: ['Sin número de ticket válido'], fields: {} }); continue; }
    if (seen.has(number)) { rows.push({ row: i + 1, number, subject, action: 'skip', warnings: ['Número repetido en el archivo'], fields: {} }); continue; }
    seen.add(number);
    const ex = byNumber.get(number);
    let action = 'create';
    if (ex) {
      if (ex.imported) action = 'update';
      else { rows.push({ row: i + 1, number, subject, action: 'skip', warnings: [`Ya existe el ticket #${number} creado en esta mesa (no se pisa)`], fields: {} }); continue; }
    }
    const f = { subject: subject || `Ticket ${number} de Desk365` };
    f.description = str(cell(r, 'description')).slice(0, 200000);
    // Estado: por nombre exacto; si no, por tipo (abierto, en espera, resuelto, cerrado)
    const stText = str(cell(r, 'status'));
    let st = statuses.find((s) => norm(s.name) === norm(stText));
    if (!st) {
      const kind = pick(stText, STATUS_KIND, 'open');
      st = statuses.find((s) => s.kind === kind && s.active && (kind !== 'open' || s.is_default)) || statuses.find((s) => s.kind === kind) || statuses.find((s) => s.is_default);
      if (stText) warnings.push(`Estado "${stText}" → ${st?.name}`);
    }
    f.status = st ? { id: st.id, name: st.name, kind: st.kind } : null;
    f.priority = pick(str(cell(r, 'priority')), PRIORITY, 1);
    f.channel = pick(str(cell(r, 'source')), CHANNEL, 'email');
    // Desde la v1.9 no hay grupos: el grupo de Desk365 se convierte en categoría técnica (y subcategoría si se reconoce)
    const gText = str(cell(r, 'group'));
    f.groupTech = gText ? groupToTech(gText, { techs, subs, groupMap }) : null;
    if (gText && !f.groupTech) warnings.push(`Grupo "${gText}": no encontré una categoría técnica equivalente`);
    const aText = str(cell(r, 'agent'));
    const a = aText ? matchUser(aText, users.filter((u) => u.active)) : null;
    if (aText && !a) warnings.push(`Agente "${aText}" no existe o está inactivo: queda sin asignar`);
    f.assignee = a ? { id: a.id, name: a.name } : null;
    // Área (categoría) y tipo: si faltan, los crea un administrador
    const make = (kind, list, text, label, fields = ['name']) => {
      const t = str(text);
      if (!t) return null;
      const alias = kind === 'type' ? TYPE_ALIASES[norm(t)] : null;
      const hit = fuzzyMatch(alias || t, list, fields) || (alias ? fuzzyMatch(t, list, fields) : null);
      if (hit) return { id: hit.id, name: hit.name };
      if (!canCreate) { warnings.push(`${label} "${t}" no existe: queda vacío`); return null; }
      const name = (alias || t).slice(0, 80);
      if (!toCreate[kind].has(norm(name))) toCreate[kind].set(norm(name), name);
      warnings.push(`${label} "${name}" no existe: se crea`);
      return { id: null, name: toCreate[kind].get(norm(name)) };
    };
    f.category = make('area', cats, cell(r, 'category'), 'Área', ['name', 'description']);
    f.type = make('type', types, cell(r, 'type'), 'Tipo');
    const tText = str(cell(r, 'tech'));
    const tech = tText ? fuzzyMatch(tText, techs) : null;
    f.tech = tech ? { id: tech.id, name: tech.name } : f.groupTech ? { id: f.groupTech.id, name: f.groupTech.name } : null;
    f.subtech = !tech && f.groupTech?.sub ? f.groupTech.sub : null;
    const sub = str(cell(r, 'subcategory'));
    // Fechas (hora de Buenos Aires)
    f.created_at = parseDeskDate(cell(r, 'created'));
    if (!f.created_at) warnings.push('Sin fecha de creación válida: se usa la de hoy');
    f.updated_at = parseDeskDate(cell(r, 'updated')) || f.created_at;
    f.first_responded_at = parseDeskDate(cell(r, 'first_response'));
    f.resolved_at = parseDeskDate(cell(r, 'resolved'));
    f.closed_at = parseDeskDate(cell(r, 'closed'));
    if (f.status?.kind === 'closed' && !f.closed_at) f.closed_at = f.updated_at;
    if (['closed', 'resolved'].includes(f.status?.kind) && !f.resolved_at) f.resolved_at = f.closed_at || f.updated_at;
    const minutes = Number(String(cell(r, 'time_total')).replace(',', '.'));
    f.minutes = Number.isFinite(minutes) && minutes > 0 && minutes < 100000 ? Math.round(minutes) : 0;
    const conv = Number(cell(r, 'conversations'));
    f.conversations = Number.isInteger(conv) && conv >= 0 ? conv : null;
    f.tags = ['desk365', ...str(cell(r, 'tags')).split(/[,;]/).map((x) => x.trim()).filter(Boolean)].slice(0, 20);
    f.cc = str(cell(r, 'cc')).split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(isEmail).slice(0, 20);
    // Solicitante: correo; si no, nombre de un contacto existente; si no, quien respondió como contacto; si no, genérico
    const email = str(cell(r, 'contact_email')).toLowerCase();
    const cname = str(cell(r, 'contact_name'));
    if (email && isEmail(email)) f.contact = { email, name: cname, how: 'email' };
    else {
      const byName = contactByName(cname)
        || (norm(cell(r, 'updated_by_type')).startsWith('contact') ? contactByName(str(cell(r, 'updated_by'))) : null);
      if (byName) { f.contact = { id: byName.id, email: byName.email, name: byName.name, how: 'name' }; warnings.push(`Solicitante por nombre: ${byName.name}`); }
      else {
        f.contact = { email: PLACEHOLDER_EMAIL, name: 'Solicitante sin datos (Desk365)', how: 'placeholder' };
        warnings.push(cname ? `No encontré el contacto "${cname}": queda un solicitante genérico` : 'La exportación no trae el solicitante: queda uno genérico');
      }
    }
    f.extra = {
      number, subcategory: sub || undefined, conversations: f.conversations ?? undefined, sla: str(cell(r, 'sla')) || undefined,
      updated_by: str(cell(r, 'updated_by')) || undefined, company: str(cell(r, 'company')) || undefined,
    };
    rows.push({ row: i + 1, number, subject: f.subject, action, fields: f, warnings });
  }
  const contactCols = map.contact_email !== undefined || map.contact_name !== undefined;
  return {
    columns: Object.keys(map), rows, contact_columns: contactCols,
    create_options: { type: [...toCreate.type.values()], area: [...toCreate.area.values()] },
  };
}

/** Aplica el plan (la ruta lo corre dentro de una transacción). No dispara reglas, IA, correos ni round robin. */
export async function applyDesk365(plan, user) {
  const ensure = async (kind, v) => {
    if (!v) return null;
    if (v.id) return v.id;
    const table = kind === 'type' ? 'ticket_types' : 'categories';
    const ex = await one(`select id from ${table} where lower(name)=lower($1)`, [v.name]);
    return ex ? ex.id : (await one(`insert into ${table}(name,sort) values ($1,99) returning id`, [v.name])).id;
  };
  let created = 0;
  let updated = 0;
  let placeholder = 0;
  for (const r of plan.rows) {
    if (r.action === 'skip') continue;
    const f = r.fields;
    let contactId = f.contact.id || null;
    if (!contactId) contactId = (await upsertContact({ email: f.contact.email, name: f.contact.name })).id;
    if (f.contact.how === 'placeholder') placeholder++;
    const vals = {
      subject: f.subject, channel: f.channel, contact_id: contactId, status_id: f.status?.id || null, priority: f.priority,
      group_id: null, assignee_id: f.assignee?.id || null, category_id: await ensure('area', f.category), type_id: await ensure('type', f.type),
      tech_category_id: f.tech?.id || null, tech_subcategory_id: f.subtech?.id || null,
    };
    const created_at = f.created_at || new Date().toISOString();
    if (r.action === 'update') {
      // Reimportar actualiza los datos (no duplica mensajes ni notas)
      // Al reimportar no se pisa la categoría técnica que ya tenga el ticket (la pudo corregir un agente) ni el grupo anterior
      await q(`update tickets set subject=$2, channel=$3, contact_id=$4, status_id=$5, priority=$6, group_id=coalesce(group_id, $7::int), assignee_id=$8, category_id=$9, type_id=$10,
          tech_subcategory_id = case when tech_category_id is null then $17::int else tech_subcategory_id end,
          tech_category_id=coalesce(tech_category_id, $11), resolved_at=$12, closed_at=$13, first_responded_at=$14, updated_at=greatest(updated_at, $15::timestamptz),
          custom = custom || jsonb_build_object('desk365', $16::jsonb)
        where number=$1 and custom ? 'desk365'`,
      [r.number, vals.subject, vals.channel, vals.contact_id, vals.status_id, vals.priority, vals.group_id, vals.assignee_id, vals.category_id, vals.type_id,
        vals.tech_category_id, f.resolved_at, f.closed_at, f.first_responded_at, f.updated_at || created_at, JSON.stringify(f.extra), vals.tech_subcategory_id]);
      updated++;
      continue;
    }
    const t = await one(`insert into tickets(number,subject,channel,contact_id,status_id,priority,group_id,assignee_id,category_id,type_id,tech_category_id,
        tags,cc,custom,created_by,created_at,updated_at,last_activity_at,first_responded_at,resolved_at,closed_at,tech_subcategory_id)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, jsonb_build_object('desk365', $14::jsonb), $15, $16::timestamptz, $17::timestamptz, $17::timestamptz, $18, $19, $20, $21)
      returning id`, [r.number, vals.subject, vals.channel, vals.contact_id, vals.status_id, vals.priority, vals.group_id, vals.assignee_id, vals.category_id, vals.type_id,
      vals.tech_category_id, f.tags, f.cc, JSON.stringify(f.extra), user.id, created_at, f.updated_at || created_at, f.first_responded_at, f.resolved_at, f.closed_at, vals.tech_subcategory_id]);
    const contact = await one('select email from contacts where id=$1', [contactId]);
    await q(`insert into ticket_messages(ticket_id,kind,author_contact_id,from_email,body_html,created_at) values ($1,'customer',$2,$3,$4,$5::timestamptz)`,
      [t.id, contactId, contact.email, f.description ? textToHtml(f.description) : '<p>(sin descripción)</p>', created_at]);
    const conv = f.conversations ? ` En Desk365 tenía <b>${f.conversations}</b> respuesta(s) o nota(s); la exportación no incluye ese detalle.` : '';
    await q(`insert into ticket_messages(ticket_id,kind,author_user_id,body_html,created_at) values ($1,'note',$2,$3, now())`, [t.id, user.id,
      `<p>Ticket importado de Desk365 (#${r.number}).${conv}${f.contact.how === 'placeholder' ? ' La exportación no traía el solicitante: cambialo desde el panel del ticket antes de responder.' : ''}${f.extra.subcategory ? ` Subcategoría en Desk365: ${escapeHtml(f.extra.subcategory)}.` : ''}</p>`]);
    if (f.minutes) await q(`insert into time_entries(ticket_id,user_id,minutes,note,spent_on) values ($1,$2,$3,'Tiempo registrado en Desk365',$4::date)`, [t.id, vals.assignee_id, f.minutes, created_at.slice(0, 10)]);
    await q(`insert into ticket_activities(ticket_id,user_id,action,details) values ($1,$2,'imported',$3::jsonb)`, [t.id, user.id, JSON.stringify({ source: 'desk365', number: r.number })]);
    created++;
  }
  // La numeración sigue después del número más alto (respeta un "primer número" configurado más alto)
  const seq = await one('select last_value, is_called from ticket_number_seq');
  const max = await one('select coalesce(max(number), 0)::int as m from tickets');
  const next = Math.max(max.m + 1, Number(seq.last_value) + (seq.is_called ? 1 : 0));
  await q(`select setval('ticket_number_seq', $1, false)`, [next]);
  return { created, updated, placeholder, next_number: next };
}
