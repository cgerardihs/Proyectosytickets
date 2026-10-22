import { q, one, tx } from './db.js';
import { requireUser } from './auth.js';
import { bad, notFound } from './http.js';
import { v, parse, idParam } from './validate.js';

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ORDER = /^[a-z_][a-z0-9_]*( (asc|desc))?(, ?[a-z_][a-z0-9_]*( (asc|desc))?)*$/;

/** Validadores por tipo de columna (largos y rangos acotados). */
const TYPE = {
  text: () => v.string({ max: 2000, optional: true }),
  name: () => v.string({ min: 1, max: 160, optional: true }),
  color: () => v.string({ max: 20, pattern: /^#[0-9a-fA-F]{3,8}$/, optional: true }),
  int: () => v.int({ min: 0, max: 2147483647, optional: true, nullable: true }),
  num: () => v.number({ optional: true, nullable: true }),
  bool: () => v.bool({ optional: true }),
  json: () => v.any({ optional: true }),
  'text[]': () => v.array(v.string({ max: 200 }), { max: 200, optional: true }),
};

/**
 * Registra GET/POST/PATCH/DELETE para una tabla de configuración.
 * fields: { columna: tipo } — los nombres de tabla y columnas son fijos en el código (nunca vienen del cliente).
 */
export function crud(router, path, table, fields, { roles = ['admin'], readRoles = null, order = 'sort, id', required = ['name'], validate, schema, beforeDelete } = {}) {
  const cols = Object.keys(fields);
  if (!IDENT.test(table) || !cols.every((c) => IDENT.test(c)) || !ORDER.test(order)) throw new Error(`crud: identificador inválido en ${table}`);
  const shape = schema || v.object(Object.fromEntries(cols.map((c) => [c, (c === 'name' ? TYPE.name : c === 'color' ? TYPE.color : TYPE[fields[c]] || TYPE.text)()])));
  const cast = (c) => (fields[c] === 'json' ? '::jsonb' : '');
  const val = (c, x) => (fields[c] === 'json' ? JSON.stringify(x ?? null) : x);

  router.get(path, async (ctx) => {
    await requireUser(ctx.req, readRoles);
    return q(`select * from ${table} order by ${order}`);
  });

  router.post(path, async (ctx) => {
    await requireUser(ctx.req, roles);
    const b = parse(shape, ctx.body);
    for (const r of required) if (b[r] === undefined || b[r] === null || String(b[r]).trim() === '') throw bad(`El campo ${r} es obligatorio`);
    const use = cols.filter((c) => b[c] !== undefined);
    try {
      return await tx(async () => {
        if (validate) await validate(b, null);
        return one(`insert into ${table}(${use.join(',')}) values (${use.map((c, i) => `$${i + 1}${cast(c)}`).join(',')}) returning *`, use.map((c) => val(c, b[c])));
      });
    } catch (e) {
      if (String(e.message).includes('unique') || e.code === '23505') throw bad('Ya existe un registro con ese nombre');
      throw e;
    }
  });

  router.patch(`${path}/:id`, async (ctx) => {
    await requireUser(ctx.req, roles);
    const id = idParam(ctx.params.id);
    const b = parse(shape, ctx.body);
    const use = cols.filter((c) => b[c] !== undefined);
    if (!use.length) return one(`select * from ${table} where id=$1`, [id]);
    try {
      return await tx(async () => {
        if (validate) await validate(b, id);
        const row = await one(`update ${table} set ${use.map((c, i) => `${c}=$${i + 2}${cast(c)}`).join(',')} where id=$1 returning *`, [id, ...use.map((c) => val(c, b[c]))]);
        if (!row) throw notFound();
        return row;
      });
    } catch (e) {
      if (String(e.message).includes('unique') || e.code === '23505') throw bad('Ya existe un registro con ese nombre');
      throw e;
    }
  });

  router.del(`${path}/:id`, async (ctx) => {
    await requireUser(ctx.req, roles);
    const id = idParam(ctx.params.id);
    if (beforeDelete) await beforeDelete(id);
    try {
      await q(`delete from ${table} where id=$1`, [id]);
    } catch (e) {
      if (e.code === '23503' || String(e.message).includes('foreign key')) {
        throw bad('No se puede eliminar porque está en uso. Desactivalo en su lugar.');
      }
      throw e;
    }
    return { ok: true };
  });
}
