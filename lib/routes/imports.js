// Importaciones desde otros sistemas: tickets de Desk365 (CSV o Excel exportado desde Desk365).
import { requireUser } from '../auth.js';
import { audit } from '../audit.js';
import { bad } from '../http.js';
import { v, parse } from '../validate.js';
import { tx } from '../db.js';
import { parseCsv } from '../csv.js';
import { readXlsx } from '../xlsx.js';
import { planDesk365, applyDesk365 } from '../desk365.js';

export function importRoutes(r) {
  // Primero vista previa (dry); al confirmar se manda el mismo archivo con dry=false
  r.post('/admin/import/desk365', async ({ req, body: raw }) => {
    const u = await requireUser(req, ['admin']);
    const body = parse(v.object({
      filename: v.string({ max: 200, default: 'tickets.csv' }),
      data: v.string({ min: 10, max: 6 * 1024 * 1024, trim: false }),
      dry: v.bool({ default: true }),
    }), raw);
    const buf = Buffer.from(body.data.replace(/^data:[^,]*,/, ''), 'base64');
    let matrix;
    try {
      if (/\.xlsx$/i.test(body.filename)) matrix = readXlsx(buf);
      else if (/\.(csv|txt)$/i.test(body.filename)) matrix = parseCsv(buf);
      else throw new Error('Subí la exportación de Desk365 en CSV o Excel (.xlsx)');
    } catch (e) {
      throw bad(e.message || 'No pude leer el archivo');
    }
    let plan;
    try { plan = await planDesk365(matrix, { canCreate: true }); } catch (e) { throw bad(e.message); }
    if (!plan.rows.length) throw bad('El archivo no tiene tickets');
    if (body.dry) return { dry: true, ...plan };
    const result = await tx(() => applyDesk365(plan, u));
    await audit(req, u, 'desk365_import', { file: body.filename, ...result });
    return { dry: false, ...result, rows: plan.rows.length };
  });
}
