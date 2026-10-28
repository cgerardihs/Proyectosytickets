// Portfolio de proyectos: listado, roadmap, exportación e importación desde Excel.
import { requireUser, isAdminRole } from '../auth.js';
import { audit } from '../audit.js';
import { send, forbidden, bad } from '../http.js';
import { v, parse } from '../validate.js';
import { tx } from '../db.js';
import { canPortfolio, portfolioRows, portfolioOptions, planImport, applyImport, PORTFOLIO_STATUS } from '../portfolio.js';
import { readXlsx, writeXlsx } from '../xlsx.js';
import { createProject, handOverLead } from './projects.js';
import { getSetting } from '../settings.js';

/** Fecha de hoy en la zona horaria de la mesa (a las 21 h de Buenos Aires, UTC ya es mañana). */
export function todayLocal(tz) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); } catch { return new Date().toISOString().slice(0, 10); }
}

async function requirePortfolio(req) {
  const u = await requireUser(req);
  if (!canPortfolio(u)) throw forbidden('No tenés acceso al portfolio. Lo habilita el superadministrador.');
  return u;
}

const HEALTH_LABEL = { late: 'Atrasado', risk: 'En riesgo', ok: 'En término', done: 'Finalizado', none: 'Sin fechas' };

export function exportColumns() {
  return [
    { header: 'Clave', width: 9, get: (p) => p.key },
    { header: 'Proyecto', width: 40, get: (p) => p.name },
    { header: 'Descripción', width: 50, get: (p) => p.description },
    { header: 'Tipo', width: 22, get: (p) => p.type_name },
    { header: 'Origen', width: 18, get: (p) => p.origin_name },
    { header: 'Sector IT', width: 20, get: (p) => p.sector_name },
    { header: 'Área', width: 22, get: (p) => p.area_name },
    { header: 'Responsable', width: 22, get: (p) => p.lead_name },
    { header: 'Estado', width: 13, get: (p) => p.status_label },
    { header: 'Prioridad', width: 10, get: (p) => p.priority_label },
    { header: 'Fecha Inicio', width: 12, type: 'date', get: (p) => (p.recurring && !p.start ? 'RECURRENTE' : p.start) },
    { header: 'Fecha Fin', width: 12, type: 'date', get: (p) => (p.recurring && !p.end ? 'RECURRENTE' : p.end) },
    { header: 'Horas Estimadas', width: 11, type: 'number', get: (p) => (p.estimated_hours === null ? null : Number(p.estimated_hours)) },
    { header: 'Horas Registradas', width: 11, type: 'hours', get: (p) => p.logged_hours },
    { header: 'Horas Manuales', width: 11, type: 'hours', get: (p) => Number(p.extra_hours || 0) },
    { header: '% Avance', width: 10, type: 'percent', get: (p) => p.progress / 100 },
    { header: 'Avance calculado', width: 12, type: 'percent', get: (p) => (p.progress_auto === null ? null : p.progress_auto / 100) },
    { header: 'Etapa actual', width: 22, get: (p) => p.current_phase },
    { header: 'Salud', width: 12, get: (p) => HEALTH_LABEL[p.health] },
    { header: 'Tickets', width: 12, get: (p) => (p.ticket_numbers || []).map((n) => `#${n}`).join(' ') },
  ];
}

export function portfolioRoutes(r) {
  r.get('/portfolio', async ({ req }) => {
    await requirePortfolio(req);
    const [rows, options, hd] = await Promise.all([portfolioRows(), portfolioOptions(), getSetting('helpdesk')]);
    const capacity = Number(hd?.portfolio_month_hours) > 0 ? Number(hd.portfolio_month_hours) : 80;
    return { rows, options, statuses: PORTFOLIO_STATUS, today: todayLocal(hd?.timezone), capacity };
  });

  r.get('/portfolio/export', async ({ req, res, query }) => {
    const u = await requirePortfolio(req);
    let rows = await portfolioRows();
    // Los mismos filtros de la pantalla (opcionales)
    const ids = (x) => String(x || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const st = String(query.status || '').split(',').filter((s) => PORTFOLIO_STATUS[s]);
    if (st.length) rows = rows.filter((p) => st.includes(p.portfolio_status));
    for (const [k, col] of [['sector', 'sector_id'], ['area', 'area_id'], ['origin', 'origin_id'], ['type', 'type_id'], ['lead', 'lead_id']]) {
      if (query[k] === 'none') { rows = rows.filter((p) => p[col] === null || p[col] === undefined); continue; }
      const list = ids(query[k]);
      if (list.length) rows = rows.filter((p) => list.includes(p[col]));
    }
    if (['late', 'risk', 'ok', 'done', 'none'].includes(query.health)) rows = rows.filter((p) => p.health === query.health);
    const text = String(query.q || '').trim().toLowerCase().slice(0, 100);
    if (text) rows = rows.filter((p) => [p.name, p.key, p.description, p.lead_name, p.current_phase].some((x) => String(x || '').toLowerCase().includes(text)));
    const cols = exportColumns();
    const phaseRows = rows.flatMap((p) => p.phases.map((f, i) => [p.key, p.name, i + 1, f.title, f.start_date, f.due_date, f.pct / 100, { done: 'Hecha', active: 'En curso', pending: 'Pendiente' }[f.state]]));
    const buf = writeXlsx([
      { name: 'Portfolio', columns: cols, rows: rows.map((p) => cols.map((c) => c.get(p))) },
      {
        name: 'Etapas',
        columns: [
          { header: 'Clave', width: 9 }, { header: 'Proyecto', width: 40 }, { header: 'N°', width: 5, type: 'number' }, { header: 'Etapa', width: 28 },
          { header: 'Inicio', width: 12, type: 'date' }, { header: 'Fin', width: 12, type: 'date' }, { header: 'Avance', width: 10, type: 'percent' }, { header: 'Estado', width: 12 },
        ],
        rows: phaseRows,
      },
    ]);
    await audit(req, u, 'portfolio_export', { rows: rows.length });
    send(res, 200, buf, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="portfolio-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    });
    return undefined;
  }, { raw: true });

  // Plantilla vacía con las columnas que entiende la importación
  r.get('/portfolio/template', async ({ req, res }) => {
    await requirePortfolio(req);
    const head = ['Proyecto', 'Descripción', 'Tipo', 'Origen', 'Sector IT', 'Área', 'Responsable', 'Estado', 'Prioridad', 'Fecha Inicio', 'Fecha Fin', 'Horas Estimadas', '% Avance', 'Horas Manuales'];
    const buf = writeXlsx([{
      name: 'Portfolio',
      columns: head.map((h) => ({ header: h, width: h === 'Proyecto' || h === 'Descripción' ? 36 : 14, type: /Fecha/.test(h) ? 'date' : /Horas/.test(h) ? 'number' : h === '% Avance' ? 'percent' : 'text' })),
      rows: [['Nuevo portal de certificados', 'Ejemplo: borrá esta fila', 'Desarrollo de software', 'OKR 26-27', 'Sistemas | Desarrollo', 'Tec y Operaciones', '', 'En curso', 'Alta', '2026-02-01', '2026-11-30', 1728, 0.7, 0]],
    }]);
    send(res, 200, buf, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="plantilla-portfolio.xlsx"',
    });
    return undefined;
  }, { raw: true });

  // Importación: primero vista previa (dry), después se confirma con el mismo archivo
  r.post('/portfolio/import', async ({ req, body: raw }) => {
    const u = await requirePortfolio(req);
    const body = parse(v.object({
      filename: v.string({ max: 200, default: 'portfolio.xlsx' }),
      data: v.string({ min: 10, max: 6 * 1024 * 1024, trim: false }),
      sheet: v.string({ max: 100, optional: true }),
      dry: v.bool({ default: true }),
    }), raw);
    if (!/\.xlsx$/i.test(body.filename)) throw bad('Subí la planilla en formato Excel (.xlsx). Si la tenés en .xls, guardala como .xlsx.');
    let matrix;
    try {
      matrix = readXlsx(Buffer.from(body.data.replace(/^data:[^,]*,/, ''), 'base64'), { sheet: body.sheet || null });
    } catch (e) {
      throw bad(e.message || 'No pude leer el archivo Excel');
    }
    let plan;
    try { plan = await planImport(matrix, { canCreateAreas: isAdminRole(u) }); } catch (e) { throw bad(e.message); }
    if (!plan.rows.length) throw bad('La planilla no tiene filas con proyectos');
    if (body.dry) return { dry: true, ...plan };
    const result = await tx(() => applyImport(plan, u, { createProject, handOverLead }));
    await audit(req, u, 'portfolio_import', { file: body.filename, ...result });
    return { dry: false, ...result, rows: plan.rows.length };
  });
}
