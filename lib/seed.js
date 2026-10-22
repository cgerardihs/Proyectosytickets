import { q, one } from './db.js';
import { setSetting } from './settings.js';

export const DEFAULT_BRAND = {
  name: 'Hanseatica',
  product: 'Mesa de Ayuda',
  color: '#C8102E',
  accent: '#F2A900',
  logo: '',
};

export const DEFAULT_HELPDESK = {
  timezone: 'America/Argentina/Buenos_Aires',
  business: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
  holidays: [],
  support_email: '',
  auto_close_days: 7,
  notify_contact_on_create: true,
  notify_contact_on_resolve: true,
  notify_agent_on_assign: true,
  portal_enabled: true,
  portal_title: 'Centro de ayuda',
  dev_phases: ['Relevamiento y análisis', 'Diseño', 'Desarrollo', 'Testing / UAT', 'Implementación'],
  dev_rules: { on_convert_status_id: null, on_start_status_id: null, on_finish_status_id: null, phase_rules: [], pause_sla: false, notify_contact_phase: false, notify_contact_finish: false, issues_done_note: true, issues_done_reopen: true, waiting_status_ids: null, issues_done_status_id: null },
  portfolio_month_hours: 80,
  portfolio_day_hours: 8,
};

const HANSEATICA = {
  categories: [
    ['Admin y Finanzas', 'Administración y Finanzas'],
    ['Siniestros y Legales', 'Siniestros y Legales'],
    ['Auditoría', 'Auditoría'],
    ['Comercial', 'Comercial'],
    ['Tec y Operaciones', 'Técnica y Operaciones'],
    ['O y M', 'Organización y Métodos'],
    ['RRHH', 'Recursos Humanos'],
    ['Marketing', 'Marketing'],
    ['Presidencia', 'Presidencia'],
  ],
  techCategories: [
    'Seguridad - Phishing, malware y accesos indebidos',
    'Hardware PC y periféricos - equipo, monitor, cámara',
    'Salas de Reunión - Conexión, pantallas y audio',
    'O365-Teams - Reuniones y chat',
    'O365-Outlook - Correo y calendario',
    'O365-Word/Excel/PowerPoint',
    'O365-OneDrive/SharePoint - Archivos en la nube',
    'Red/VPN - WiFi, cable, VPN',
    'EQUIS - Uso diario de EQUIS',
    'EQUIS - DESARROLLOS - Bugs o mejoras EQUIS',
    'Incidente - Falla masiva',
    'Desbloqueos - Desbloqueo o reset de clave',
    'Altas de Usuarios - Crear/baja/reactivar cuenta',
    'Aplicaciones - CRM, portales, otras apps',
    'Celular - Soporte móvil corporativo',
    'Impresión - Print, escaneo, insumos',
    'Soporte',
  ],
  agents: [
    ['Fernando Horta', 'fhorta@hanseatica.com', 'admin', ['Soporte']],
    ['Matias Ayala', 'mayala@hanseatica.com', 'admin', ['Aplicaciones - CRM, portales, otras apps']],
    ['Juan Manuel Torres', 'jtorres@hanseatica.com', 'admin', ['Aplicaciones - CRM, portales, otras apps', 'EQUIS - DESARROLLOS - Bugs o mejoras EQUIS', 'Reporting']],
    ['Andres Castañon', 'acastanon@hanseatica.com', 'admin', ['Soporte', 'Solamente para nuevos ingresos de Personal']],
    ['Carlos Gerardi', 'cgerardi@hanseatica.com', 'admin', ['Soporte', 'Aplicaciones - CRM, portales, otras apps', 'EQUIS - Uso diario de EQUIS', 'EQUIS - DESARROLLOS - Bugs o mejoras EQUIS', 'Reporting', 'Solamente para nuevos ingresos de Personal']],
    ['Martin Tamburrini', 'mtamburrini@hanseatica.com', 'agent', ['Soporte', 'EQUIS - Uso diario de EQUIS', 'EQUIS - DESARROLLOS - Bugs o mejoras EQUIS']],
    ['Richards Pulgar', 'rpulgar@hanseatica.com', 'admin', ['Soporte', 'Solamente para nuevos ingresos de Personal']],
    ['Matias Piris', 'mpiris@hanseatica.com', 'agent', ['Aplicaciones - CRM, portales, otras apps']],
    ['Mariano Ruiz', 'mruiz@hanseatica.com', 'admin', ['Aplicaciones - CRM, portales, otras apps', 'Reporting']],
    ['Homero Monsalvo', 'hmonsalvo@hanseatica.com', 'agent', ['Aplicaciones - CRM, portales, otras apps']],
    ['Nicolas Coton', 'ncoton@hanseatica.com', 'agent', ['EQUIS - Uso diario de EQUIS', 'EQUIS - DESARROLLOS - Bugs o mejoras EQUIS']],
    ['Nicolas Sassone', 'nsassone@hanseatica.com', 'agent', ['Aplicaciones - CRM, portales, otras apps']],
  ],
};

const GENERIC = {
  categories: [['General', ''], ['Administración', ''], ['Comercial', ''], ['Operaciones', '']],
  techCategories: ['Hardware', 'Software', 'Red / VPN', 'Correo', 'Accesos y claves', 'Impresión', 'Otros'],
  agents: [],
};

const COLORS = ['#C8102E', '#2563EB', '#059669', '#D97706', '#7C3AED', '#DB2777', '#0891B2', '#65A30D', '#EA580C', '#4F46E5', '#0D9488', '#B45309'];

export async function seedConfig(preset = 'hanseatica', domain = '') {
  const data = preset === 'hanseatica' ? HANSEATICA : GENERIC;
  const brand = preset === 'hanseatica' ? DEFAULT_BRAND : { ...DEFAULT_BRAND, name: 'Mi empresa', color: '#2563EB', accent: '#F59E0B' };
  await setSetting('brand', brand, true);
  await setSetting('helpdesk', { ...DEFAULT_HELPDESK, support_email: preset === 'hanseatica' ? 'ayuda@hanseatica.com' : '' }, true);

  const has = await one('select count(*)::int as n from statuses');
  if (has.n === 0) {
    const st = [
      ['Abierto', 'open', '#2563EB', false, true],
      ['Pendiente', 'pending', '#D97706', true, false],
      ['Stdby', 'pending', '#7C3AED', true, false],
      ['En espera de desarrollo', 'pending', '#0891B2', true, false],
      ['Resuelto', 'resolved', '#059669', false, false],
      ['Cerrado', 'closed', '#475569', false, false],
    ];
    for (const [i, s] of st.entries()) {
      await q('insert into statuses(name,kind,color,pauses_sla,is_default,sort) values ($1,$2,$3,$4,$5,$6)', [...s, i]);
    }
    const types = ['Incidente', 'Solicitud', 'Consulta', 'Mejora / Desarrollo', 'Problema'];
    for (const [i, t] of types.entries()) await q('insert into ticket_types(name,sort) values ($1,$2)', [t, i]);
    await q(`insert into sla_policies(name,is_default,no_sla,business_hours,targets,sort) values
      ('Sin SLA', true, true, true, '{}'::jsonb, 0),
      ('SLA estándar', false, false, true, $1::jsonb, 1)`, [JSON.stringify({
      1: { first: 8, resolve: 72 }, 2: { first: 4, resolve: 24 }, 3: { first: 2, resolve: 8 }, 4: { first: 1, resolve: 4 },
    })]);
  }

  const c = await one('select count(*)::int as n from categories');
  if (c.n === 0) {
    for (const [i, [name, desc]] of data.categories.entries()) await q('insert into categories(name,description,sort) values ($1,$2,$3)', [name, desc, i]);
  }
  const tc = await one('select count(*)::int as n from tech_categories');
  if (tc.n === 0) {
    for (const [i, name] of data.techCategories.entries()) await q('insert into tech_categories(name,sort) values ($1,$2)', [name, i]);
  }
  for (const [i, [name, email, role]] of data.agents.entries()) {
    await one(
      `insert into users(name,email,role,color) values ($1,lower($2),$3,$4)
       on conflict (email) do update set name = excluded.name returning id`,
      [name, email, role, COLORS[i % COLORS.length]],
    );
  }
  if (preset === 'hanseatica' || domain) {
    const name = preset === 'hanseatica' ? 'Hanseatica' : domain.split('.')[0];
    const dom = preset === 'hanseatica' ? 'hanseatica.com' : domain;
    await q('insert into companies(name,domain) values ($1,$2) on conflict (name) do nothing', [name, dom]);
  }
  const kb = await one('select count(*)::int as n from kb_categories');
  if (kb.n === 0) {
    await q(`insert into kb_categories(name,description,sort) values ('General','Guías de uso',0),('Preguntas frecuentes','Respuestas rápidas',1)`);
  }
  const cr = await one('select count(*)::int as n from canned_responses');
  if (cr.n === 0) {
    await q(`insert into canned_responses(title,folder,body_html) values
      ('Recibimos tu solicitud','General','<p>Hola {{contacto.nombre}}, recibimos tu solicitud <b>#{{ticket.numero}}</b> y ya la estamos revisando. Te mantenemos al tanto.</p>'),
      ('Pedido de más información','General','<p>Hola {{contacto.nombre}}, para avanzar necesitamos que nos envíes una captura de pantalla del error y el paso a paso para reproducirlo. ¡Gracias!</p>'),
      ('Resuelto','General','<p>Hola {{contacto.nombre}}, dejamos resuelto el ticket <b>#{{ticket.numero}}</b>. Si el problema persiste, respondé este correo y lo reabrimos.</p>')`);
  }
}

/** Datos de ejemplo para probar el sistema (opcional en la instalación). */
export async function seedDemo(adminId) {
  const contact = await one(
    `insert into contacts(name,email,company_id,area) values ('Ignacio Parreta','iparreta@hanseatica.com',(select id from companies order by id limit 1),'Tec y Operaciones')
     on conflict (email) do update set name=excluded.name returning id`,
  );
  const st = await one(`select id from statuses where is_default limit 1`);
  const tech = await one(`select id from tech_categories where active order by sort limit 1`);
  const cat = await one(`select id from categories order by sort limit 1 offset 4`);
  const t = await one(
    `insert into tickets(subject,channel,contact_id,status_id,priority,tech_category_id,category_id,assignee_id,created_by)
     values ('Ejemplo: no imprime la factura desde el portal','email',$1,$2,1,$3,$4,$5,$5) returning id, number`,
    [contact.id, st.id, tech?.id || null, cat?.id || null, adminId],
  );
  await q(`insert into ticket_messages(ticket_id,kind,author_contact_id,from_email,body_html) values ($1,'customer',$2,'iparreta@hanseatica.com','<p>Hola, al intentar imprimir la factura desde el portal me sale una pantalla en blanco. ¿Me ayudan?</p>')`, [t.id, contact.id]);

  const p = await one(`insert into projects(key,name,description,lead_id,color,type_id) values ('DEMO','Proyecto de ejemplo','Proyecto para conocer el tablero, el backlog y los sprints.',$1,'#C8102E',
    (select id from project_types where is_default order by id limit 1)) returning id`, [adminId]);
  const sts = [['Por hacer', 'todo'], ['En curso', 'doing'], ['En revisión', 'doing'], ['Hecho', 'done']];
  const sIds = [];
  for (const [i, [n, k]] of sts.entries()) sIds.push((await one('insert into project_statuses(project_id,name,kind,sort) values ($1,$2,$3,$4) returning id', [p.id, n, k, i])).id);
  await q('insert into project_members(project_id,user_id) values ($1,$2)', [p.id, adminId]);
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const plus = (n) => new Date(today.getTime() + n * 86400000);
  const sp = await one(`insert into sprints(project_id,name,goal,state,start_date,end_date,sort) values ($1,'DEMO Sprint 1','Dejar operativa la primera versión',  'active',$2,$3,0) returning id`, [p.id, iso(plus(-5)), iso(plus(9))]);
  let n = 0;
  const mk = async (type, title, statusIdx, extra = {}) => {
    n += 1;
    const row = await one(
      `insert into issues(project_id,number,key,type,title,status_id,priority,assignee_id,reporter_id,parent_id,sprint_id,story_points,rank,start_date,due_date,resolved_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
      [p.id, n, `DEMO-${n}`, type, title, sIds[statusIdx], extra.priority || 2, adminId, extra.parent || null, extra.sprint || null, extra.points ?? null, n * 1000,
        extra.start || null, extra.due || null, statusIdx === 3 ? new Date().toISOString() : null],
    );
    return row.id;
  };
  const e1 = await mk('epic', 'Portal de autogestión', 1, { start: iso(plus(-10)), due: iso(plus(40)) });
  const e2 = await mk('epic', 'Integración con Equis', 0, { start: iso(plus(20)), due: iso(plus(80)) });
  await mk('story', 'Como usuario quiero ver mis facturas', 1, { parent: e1, sprint: sp.id, points: 5 });
  await mk('task', 'Diseñar pantalla de login', 3, { parent: e1, sprint: sp.id, points: 3 });
  await mk('bug', 'Error al descargar PDF', 2, { parent: e1, sprint: sp.id, points: 2, priority: 3 });
  await mk('story', 'Consultar deuda desde Equis', 0, { parent: e2, points: 8 });
  await mk('task', 'Definir contrato de la API', 0, { parent: e2, points: 3 });
  await q('update projects set issue_seq=$2 where id=$1', [p.id, n]);
}

// ---------- v1.4: reglas de respuesta automática de ejemplo ----------
const AI_RULES = [
  {
    name: 'Correo / Outlook', keywords: ['correo', 'correos', 'outlook', 'mails', 'bandeja de entrada'], tech: 'O365-Outlook', mode: 'guide_ai', on_confirm: 'resolve',
    guide: '1. Cierre Outlook y reinicie la computadora.\n2. Ingrese a outlook.office.com con su usuario: si ahí ve los correos, el problema es solo de la aplicación.\n3. Revise que la barra inferior de Outlook no diga "Desconectado" o "Trabajar sin conexión".',
  },
  {
    name: 'Desbloqueo de clave', keywords: ['contraseña', 'desbloquear', 'desbloqueo', 'cuenta bloqueada', 'usuario bloqueado'], tech: 'Desbloqueos', mode: 'fixed', on_confirm: 'resolve',
    guide: '1. Ingrese a https://aka.ms/sspr y restablezca su contraseña de Microsoft 365 con el teléfono que tiene registrado.\n2. Si no tiene un método registrado, responda este ticket y un agente lo va a desbloquear.',
  },
  {
    name: 'Impresoras', keywords: ['impresora', 'imprimir', 'imprime', 'toner'], tech: null, mode: 'guide_ai', on_confirm: 'keep_open',
    guide: '1. Verifique que la impresora esté encendida, con papel y sin atascos.\n2. Apague la impresora, espere 30 segundos y vuelva a encenderla.\n3. En la computadora, borre los trabajos pendientes de la cola de impresión y vuelva a imprimir.',
  },
  {
    name: 'Teams', keywords: ['teams', 'videollamada', 'microfono', 'camara'], tech: 'O365-Teams', mode: 'guide_ai', on_confirm: 'resolve',
    guide: '1. Cierre Teams por completo (también desde el ícono junto al reloj) y vuelva a abrirlo.\n2. Pruebe entrar desde el navegador en teams.microsoft.com.\n3. En Configuración > Dispositivos, elija el micrófono y la cámara correctos.',
  },
];

/** Carga las reglas de ejemplo una sola vez (instalaciones nuevas y actualizaciones a v1.4). */
export async function seedAiRules() {
  const done = await one(`select 1 as x from app_settings where key='ai_rules_seeded'`);
  if (done) return;
  const n = await one('select count(*)::int as n from ai_rules');
  if (!n.n) {
    for (const [i, r] of AI_RULES.entries()) {
      const tech = r.tech ? await one('select id from tech_categories where name ilike $1 limit 1', [`${r.tech}%`]) : null;
      await q(`insert into ai_rules(name,keywords,tech_category_ids,guide,mode,on_confirm,sort) values ($1,$2,$3,$4,$5,$6,$7)`,
        [r.name, r.keywords, tech ? [tech.id] : [], r.guide, r.mode, r.on_confirm, i]);
    }
  }
  await q(`insert into app_settings(key,value) values ('ai_rules_seeded','true'::jsonb) on conflict (key) do nothing`);
}
