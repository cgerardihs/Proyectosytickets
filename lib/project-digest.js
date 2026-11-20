// Resumen diario de un proyecto (v1.27): al contacto del área solicitante, con las tareas que se finalizaron desde el
// último resumen. Corre en la tarea diaria (/cron/daily). Cada tarea se avisa una sola vez (issues.done_notified_at): si
// se reabre y se vuelve a finalizar, no se manda de nuevo. Las subtareas y las etapas no se avisan.
import { q } from './db.js';
import { renderMail, mailTemplates } from './mail-templates.js';
import { sendMail, layout, escapeHtml, mailEnabled } from './mail.js';
import { getSetting } from './settings.js';
import { logError } from './log.js';

const dm = (d, tz) => {
  try { return new Intl.DateTimeFormat('es-AR', { timeZone: tz, day: '2-digit', month: '2-digit' }).format(new Date(d)); } catch { return ''; }
};

/** Proyectos con tareas finalizadas sin avisar y un contacto que recibe el resumen. Con projectId, solo ese. */
async function pendingProjects(projectId = null) {
  return q(`select p.id, p.key, p.name, c.id as contact_id, c.name as contact_name, c.email as contact_email
    from projects p join contacts c on c.id = p.contact_id
    where p.notify_contact and not p.archived and c.email is not null ${projectId ? 'and p.id = $1' : ''}
      and exists (select 1 from issues i where i.project_id = p.id and i.type not in ('epic','subtask') and i.task_state = 'done' and i.done_notified_at is null)
    order by p.id`, projectId ? [projectId] : []);
}

/** Manda el resumen de un proyecto. Devuelve cuántas tareas se avisaron (0 si no había o no se pudo mandar). */
async function sendOne(p, tz) {
  const tasks = await q(`select id, key, title, resolved_at from issues where project_id=$1 and type not in ('epic','subtask') and task_state='done'
    and done_notified_at is null order by coalesce(resolved_at, updated_at), id limit 100`, [p.id]);
  if (!tasks.length) return 0;
  const { projectSummary } = await import('./routes/projects.js');
  const summary = await projectSummary(p.id).catch(() => null);
  const progress = summary?.progress ?? 0;
  const list = `<ul>${tasks.map((t) => `<li>${escapeHtml(t.title)}${t.resolved_at ? ` <span style="color:#6b7280">(${dm(t.resolved_at, tz)})</span>` : ''}</li>`).join('')}</ul>`;
  const ctx = { contact: { name: p.contact_name, email: p.contact_email }, project: { name: p.name, progress }, tareas: list };
  const { subject, html } = await renderMail('project_digest', ctx);
  const r = await sendMail({ to: p.contact_email, subject: subject || `Novedades del proyecto ${p.name}`, html: await layout(html), idempotencyKey: `digest-${p.id}-${tasks.map((t) => t.id).join('-')}` });
  if (!r.sent) { logError('No se pudo mandar el resumen del proyecto', { project: p.key, error: r.error }); return 0; }
  await q('update issues set done_notified_at = now() where id = any($1::int[])', [tasks.map((t) => t.id)]);
  for (const t of tasks) {
    await q(`insert into issue_activities(issue_id,user_id,action,details) values ($1,null,'digest_sent',$2::jsonb)`, [t.id, JSON.stringify({ to: p.contact_name || p.contact_email })]);
  }
  return tasks.length;
}

/** Todos los resúmenes pendientes (tarea diaria). */
export async function sendProjectDigests({ projectId = null } = {}) {
  if (!(await mailEnabled())) return { projects: 0, tasks: 0, skipped: 'sin correo configurado' };
  const tz = ((await getSetting('helpdesk')) || {}).timezone || 'America/Argentina/Buenos_Aires';
  await mailTemplates();
  let projects = 0;
  let tasks = 0;
  for (const p of await pendingProjects(projectId)) {
    const n = await sendOne(p, tz).catch((e) => { logError('Resumen de proyecto', { project: p.key, error: e.message }); return 0; });
    if (n) { projects += 1; tasks += n; }
  }
  return { projects, tasks };
}

/** Al cambiar el contacto, lo que ya estaba finalizado no se le manda (solo lo que se finalice de ahí en adelante). */
export async function markDoneAsNotified(projectId) {
  await q(`update issues set done_notified_at = now() where project_id=$1 and task_state='done' and type not in ('epic','subtask') and done_notified_at is null`, [projectId]);
}
