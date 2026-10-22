// Reglas de negocio entre un ticket y su proyecto de desarrollo.
// Se configuran en Configuración → Proyectos de desarrollo (setting helpdesk.dev_rules).
import { q, one } from './db.js';
import { getSetting } from './settings.js';
import { logActivity, notify, emailContact, ticketSubjectTag } from './tickets-core.js';
import { escapeHtml } from './mail.js';

export const DEFAULT_DEV_RULES = {
  on_convert_status_id: null, // null = mantener el estado actual del ticket
  on_start_status_id: null,
  on_finish_status_id: null,
  phase_rules: [], // [{ phase: 'Testing / UAT', status_id: 3 }]
  pause_sla: false,
  notify_contact_phase: false,
  notify_contact_finish: false,
  // Cierre de ciclo por tareas: cuando todas las tareas vinculadas a un ticket se finalizan
  issues_done_note: true, // nota privada en el ticket + aviso al agente asignado
  issues_done_reopen: true, // reabrir si el ticket estaba "en espera de desarrollo"
  waiting_status_ids: null, // null = los estados que se llaman "En espera de desarrollo"
  issues_done_status_id: null, // null = el estado abierto por defecto
};

export async function devRules() {
  const hd = (await getSetting('helpdesk')) || {};
  return { ...DEFAULT_DEV_RULES, ...(hd.dev_rules || {}) };
}

/** Estado resumido del proyecto: pending (nada empezado), active, finished. */
export function projectState(s) {
  if (!s) return { state: 'pending', phase: null };
  const state = s.finished ? 'finished' : s.phases.some((f) => f.state !== 'pending') ? 'active' : 'pending';
  return { state, phase: s.current?.title || null };
}

async function statusExists(id) {
  if (!id) return null;
  return one('select id,name from statuses where id=$1 and active', [Number(id)]);
}

async function pauseSla(ticketId) {
  await q('update tickets set sla_paused_at=coalesce(sla_paused_at, now()) where id=$1', [ticketId]);
}

async function resumeSla(ticketId) {
  const t = await one('select t.sla_paused_at, s.pauses_sla from tickets t left join statuses s on s.id=t.status_id where t.id=$1', [ticketId]);
  if (!t?.sla_paused_at || t.pauses_sla) return; // si el estado actual también pausa, sigue en pausa
  const secs = Math.round((Date.now() - new Date(t.sla_paused_at).getTime()) / 1000);
  await q(`update tickets set resolution_due = resolution_due + ($2 || ' seconds')::interval, sla_paused_at=null where id=$1`, [ticketId, String(secs)]);
}

async function emailPhase(ticketId, user, html, req) {
  const t = await one('select * from tickets where id=$1', [ticketId]);
  if (!t?.contact_id) return;
  const contact = await one('select * from contacts where id=$1', [t.contact_id]);
  if (!contact) return;
  await q(`insert into ticket_messages(ticket_id,kind,author_user_id,from_email,to_emails,body_html) values ($1,'reply',$2,$3,$4,$5)`, [t.id, user?.id || null, user?.email || '', [contact.email], html]);
  await emailContact(t, contact, { subject: `Re: ${await ticketSubjectTag(t)}`, html, req });
}

/** Al convertir/vincular: aplica la regla "al convertir" y guarda el punto de partida del proyecto. */
export async function onTicketLinked(ticket, summary, user, req, { updateTicket }) {
  const rules = await devRules();
  const { state, phase } = projectState(summary);
  await q('update ticket_projects set last_state=$3, last_phase=$4 where ticket_id=$1 and project_id=$2', [ticket.id, summary.id, state, phase]);
  const st = await statusExists(rules.on_convert_status_id);
  if (st && st.id !== ticket.status_id) {
    await updateTicket(ticket, { status_id: st.id }, user, req);
    await logActivity(ticket.id, user?.id, 'dev_rule', { event: 'convert', status: st.name });
  }
  if (rules.pause_sla && state !== 'finished') await pauseSla(ticket.id);
}

/**
 * Evalúa los cambios de un proyecto y aplica las reglas a sus tickets vinculados.
 * Solo dispara en transiciones (arranca, cambia de fase, termina), no en cada actualización.
 */
export async function evaluateDevRules(projectId, user, req, { projectSummary, updateTicket }) {
  const links = await q(`select tp.*, t.id as tid from ticket_projects tp join tickets t on t.id=tp.ticket_id
    where tp.project_id=$1 and t.deleted_at is null`, [projectId]);
  if (!links.length) return;
  const s = await projectSummary(projectId);
  if (!s) return;
  const rules = await devRules();
  const { state, phase } = projectState(s);
  for (const l of links) {
    const prevState = l.last_state || 'pending';
    const events = [];
    if (prevState === 'pending' && state === 'active') events.push('start');
    if (state !== 'finished' && phase && phase !== l.last_phase && l.last_phase !== null) events.push('phase');
    if (state === 'finished' && prevState !== 'finished') events.push('finish');
    await q('update ticket_projects set last_state=$3, last_phase=$4 where ticket_id=$1 and project_id=$2', [l.ticket_id, projectId, state, phase]);
    if (!events.length) continue;

    let target = null;
    if (events.includes('start')) target = (await statusExists(rules.on_start_status_id)) || target;
    if (events.includes('phase')) {
      const rule = (rules.phase_rules || []).find((r) => String(r.phase || '').trim().toLowerCase() === String(phase).trim().toLowerCase());
      target = (await statusExists(rule?.status_id)) || target;
    }
    if (events.includes('finish')) target = (await statusExists(rules.on_finish_status_id)) || target;

    const ticket = await one('select * from tickets where id=$1', [l.ticket_id]);
    if (target && target.id !== ticket.status_id) await updateTicket(ticket, { status_id: target.id }, user, req);
    await logActivity(l.ticket_id, user?.id, 'dev_rule', { event: events.join(','), phase, status: target?.name || null, project: s.key });

    if (events.includes('finish')) {
      if (rules.pause_sla) await resumeSla(l.ticket_id);
      const followers = await q('select user_id from ticket_followers where ticket_id=$1', [l.ticket_id]);
      await notify([ticket.assignee_id, ...followers.map((f) => f.user_id)], `Terminó el desarrollo del ticket #${ticket.number}`, `${s.key} · ${s.name}: todas las fases están completas`, `#/tickets/${ticket.number}`, user?.id);
      if (rules.notify_contact_finish) {
        await emailPhase(l.ticket_id, user, `<p>Hola, terminamos el desarrollo de tu pedido <b>#${ticket.number}</b> (${escapeHtml(s.name)}). Todas las fases están completas.</p>`, req);
      }
    } else if (events.includes('phase')) {
      await notify([ticket.assignee_id], `#${ticket.number}: el desarrollo pasó a ${phase}`, `${s.key} · avance ${s.progress}%`, `#/tickets/${ticket.number}`, user?.id);
      if (rules.notify_contact_phase) {
        await emailPhase(l.ticket_id, user, `<p>Hola, el desarrollo de tu pedido <b>#${ticket.number}</b> avanzó a la fase <b>${escapeHtml(phase)}</b>. Avance total: ${s.progress}%.</p>`, req);
      }
    }
  }
}

/** Estados que cuentan como "en espera de desarrollo". Sin configurar: los que se llaman así. */
export async function waitingStatusIds(rules) {
  if (Array.isArray(rules.waiting_status_ids)) return rules.waiting_status_ids.map(Number).filter(Boolean);
  const rows = await q(`select id from statuses where lower(name) like '%espera%desarrollo%'`);
  return rows.map((r) => r.id);
}

async function reopenStatus(rules) {
  const st = rules.issues_done_status_id ? await one(`select id,name from statuses where id=$1 and active and kind='open'`, [Number(rules.issues_done_status_id)]) : null;
  if (st) return st;
  return one(`select id,name from statuses where active and kind='open' order by is_default desc, sort, id limit 1`);
}

const keyLink = (k) => `<a href="#/issue/${escapeHtml(k)}"><b>${escapeHtml(k)}</b></a>`;

/**
 * Cierre de ciclo: una tarea pasó a Finalizado. Para cada ticket vinculado, si TODAS sus tareas
 * vinculadas quedaron finalizadas, deja una nota privada, avisa al agente asignado y, si el ticket
 * estaba "en espera de desarrollo", lo reabre. Nunca le responde al usuario.
 */
export async function onIssueDone(issue, user, req, { updateTicket }) {
  const rules = await devRules();
  if (!rules.issues_done_note && !rules.issues_done_reopen) return [];
  const linked = await q(`select t.id from ticket_issue_links l join tickets t on t.id=l.ticket_id
    where l.issue_id=$1 and t.deleted_at is null and not coalesce(t.spam,false) and t.merged_into is null order by t.id`, [issue.id]);
  if (!linked.length) return [];
  // Bloquea los tickets: si dos personas terminan las dos últimas tareas a la vez, la segunda ve las dos hechas
  await q('select id from tickets where id = any($1::int[]) order by id for update', [linked.map((x) => x.id)]);
  const waiting = rules.issues_done_reopen ? await waitingStatusIds(rules) : [];
  const fired = [];
  for (const { id } of linked) {
    const ticket = await one('select t.*, s.kind as status_kind, s.name as status_name from tickets t left join statuses s on s.id=t.status_id where t.id=$1', [id]);
    if (!ticket || ticket.status_kind === 'closed') continue;
    const issues = await q(`select i.key, ps.kind from ticket_issue_links l join issues i on i.id=l.issue_id
      left join project_statuses ps on ps.id=i.status_id where l.ticket_id=$1 order by i.project_id, i.number`, [id]);
    if (!issues.length || issues.some((x) => x.kind !== 'done')) continue;

    let reopened = null;
    if (rules.issues_done_reopen && waiting.includes(ticket.status_id)) {
      const target = await reopenStatus(rules);
      if (target && target.id !== ticket.status_id) {
        await updateTicket(ticket, { status_id: target.id }, user, req);
        reopened = { from: ticket.status_name, to: target.name };
      }
    }
    const who = escapeHtml(user?.name || 'el equipo de desarrollo');
    const keys = issues.map((x) => x.key);
    if (rules.issues_done_note) {
      const head = keys.length === 1
        ? `🎉 La tarea de desarrollo ${keyLink(keys[0])} vinculada a este ticket fue finalizada por <b>@${who}</b>. Ya podés validar y responder al usuario.`
        : `🎉 Las tareas de desarrollo ${keys.map(keyLink).join(', ')} vinculadas a este ticket están todas finalizadas. La última (${keyLink(issue.key)}) la finalizó <b>@${who}</b>. Ya podés validar y responder al usuario.`;
      const tail = reopened ? `<p>El ticket pasó de «${escapeHtml(reopened.from)}» a «${escapeHtml(reopened.to)}».</p>` : '';
      await q(`insert into ticket_messages(ticket_id,kind,author_user_id,body_html,meta) values ($1,'note',null,$2,$3::jsonb)`,
        [id, `<p>${head}</p>${tail}`, JSON.stringify({ dev_cycle: true, issues: keys, by: user?.id || null })]);
      await q('update tickets set updated_at=now() where id=$1', [id]);
      let to = [ticket.assignee_id];
      if (!ticket.assignee_id) to = (await q('select user_id from ticket_followers where ticket_id=$1', [id])).map((f) => f.user_id);
      await notify(to, `🎉 #${ticket.number}: terminó el desarrollo`,
        `${keys.length === 1 ? `${keys[0]} fue finalizada` : `${keys.length} tareas finalizadas`} por ${user?.name || 'desarrollo'}. Ya podés validar y responder al usuario.`,
        `#/tickets/${ticket.number}`, user?.id);
    }
    await logActivity(id, user?.id, 'dev_rule', { event: 'issues_done', issues: keys, status: reopened?.to || null });
    fired.push({ ticket: ticket.number, reopened: Boolean(reopened) });
  }
  return fired;
}
