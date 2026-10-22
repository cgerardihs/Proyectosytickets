// Validación de todo lo que entra: tipos, largos, rangos, formatos y listas permitidas.
// Los esquemas devuelven un objeto limpio (sin campos desconocidos); ante un error responden 400 con el campo.
import { HttpError } from './http.js';
import { sanitizeHtml } from './sanitize.js';

export class ValidationError extends HttpError {
  constructor(message, field) {
    super(400, message);
    this.field = field;
  }
}

const fail = (label, msg) => { throw new ValidationError(`${label}: ${msg}`, label); };
const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function make(check, opts = {}) {
  const fn = (value, label) => {
    if (value === undefined || (value === '' && !opts.allowEmpty)) {
      if (opts.default !== undefined) return typeof opts.default === 'function' ? opts.default() : opts.default;
      if (opts.optional) return undefined;
      fail(label, 'es obligatorio');
    }
    if (value === null) {
      if (opts.nullable || opts.optional) return null;
      fail(label, 'es obligatorio');
    }
    return check(value, label);
  };
  fn.opts = opts;
  return fn;
}

export const v = {
  /** Texto: recorta, quita caracteres de control y valida largo y patrón. */
  string: ({ min = 0, max = 1000, pattern, trim = true, multiline = false, ...o } = {}) => make((x, label) => {
    if (typeof x !== 'string' && typeof x !== 'number') fail(label, 'tiene que ser texto');
    let s = String(x);
    s = multiline ? s.replace(CONTROL, '') : s.replace(CONTROL, '').replace(/[\r\n\t]+/g, ' ');
    if (trim) s = s.trim();
    if (s.length < min) fail(label, min === 1 ? 'es obligatorio' : `tiene que tener al menos ${min} caracteres`);
    if (s.length > max) fail(label, `supera los ${max} caracteres`);
    if (pattern && s !== '' && !pattern.test(s)) fail(label, 'tiene un formato inválido');
    return s;
  }, { allowEmpty: min === 0, ...o }),
  email: (o = {}) => make((x, label) => {
    const s = String(x ?? '').trim().toLowerCase();
    if (s.length > 254 || !EMAIL.test(s)) fail(label, 'no es un correo válido');
    return s;
  }, o),
  int: ({ min = -2147483648, max = 2147483647, ...o } = {}) => make((x, label) => {
    const n = typeof x === 'number' ? x : /^-?\d+$/.test(String(x).trim()) ? Number(x) : NaN;
    if (!Number.isInteger(n)) fail(label, 'tiene que ser un número entero');
    if (n < min || n > max) fail(label, `tiene que estar entre ${min} y ${max}`);
    return n;
  }, o),
  number: ({ min = -1e12, max = 1e12, ...o } = {}) => make((x, label) => {
    const n = Number(x);
    if (!Number.isFinite(n)) fail(label, 'tiene que ser un número');
    if (n < min || n > max) fail(label, `tiene que estar entre ${min} y ${max}`);
    return n;
  }, o),
  id: (o = {}) => v.int({ min: 1, ...o }),
  bool: (o = {}) => make((x, label) => {
    if (typeof x === 'boolean') return x;
    if (x === 'true' || x === 1 || x === '1' || x === 'on') return true;
    if (x === 'false' || x === 0 || x === '0') return false;
    return fail(label, 'tiene que ser verdadero o falso');
  }, o),
  enum: (values, o = {}) => make((x, label) => {
    if (!values.includes(x)) fail(label, `tiene que ser uno de: ${values.join(', ')}`);
    return x;
  }, o),
  date: (o = {}) => make((x, label) => {
    const s = String(x).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) fail(label, 'tiene que ser una fecha AAAA-MM-DD');
    return s;
  }, o),
  url: ({ https = true, ...o } = {}) => make((x, label) => {
    let u;
    try { u = new URL(String(x).trim()); } catch { return fail(label, 'no es una URL válida'); }
    if (https ? u.protocol !== 'https:' : !['http:', 'https:'].includes(u.protocol)) fail(label, 'tiene que empezar con https://');
    if (String(x).length > 2000) fail(label, 'es demasiado larga');
    return u.toString();
  }, o),
  /** HTML enriquecido: se sanitiza con lista blanca (sin scripts, eventos ni javascript:). */
  html: ({ max = 500000, ...o } = {}) => make((x, label) => {
    if (typeof x !== 'string') fail(label, 'tiene que ser texto');
    if (x.length > max) fail(label, 'es demasiado largo');
    return sanitizeHtml(x);
  }, { allowEmpty: true, ...o }),
  array: (item, { max = 200, ...o } = {}) => make((x, label) => {
    if (!Array.isArray(x)) fail(label, 'tiene que ser una lista');
    if (x.length > max) fail(label, `admite como máximo ${max} elementos`);
    return x.map((el, i) => item(el, `${label}[${i}]`)).filter((el) => el !== undefined);
  }, o),
  /** Lista separada por comas o array. */
  list: (item, { max = 200, ...o } = {}) => make((x, label) => {
    const arr = Array.isArray(x) ? x : String(x).split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    if (arr.length > max) fail(label, `admite como máximo ${max} elementos`);
    return arr.map((el, i) => item(el, `${label}[${i}]`)).filter((el) => el !== undefined && el !== '');
  }, o),
  object: (shape, { unknown = 'strip', ...o } = {}) => make((x, label) => {
    if (typeof x !== 'object' || Array.isArray(x)) fail(label, 'tiene que ser un objeto');
    const out = {};
    for (const [k, check] of Object.entries(shape)) {
      const val = check(x[k], label ? `${label}.${k}` : k);
      if (val !== undefined) out[k] = val;
    }
    if (unknown === 'error') {
      const extra = Object.keys(x).filter((k) => !(k in shape));
      if (extra.length) fail(label || 'cuerpo', `campos no permitidos: ${extra.join(', ')}`);
    }
    return out;
  }, o),
  /** Adjuntos en base64 (máx. 3 MB c/u). */
  attachment: (o = {}) => v.object({
    name: v.string({ min: 1, max: 200 }),
    type: v.string({ max: 120, optional: true, pattern: /^[\w.+-]+\/[\w.+-]+$/ }),
    data: v.string({ min: 1, max: 4.2 * 1024 * 1024, trim: false, multiline: true, pattern: /^(data:[\w.+/-]+;base64,)?[A-Za-z0-9+/=\s]+$/ }),
    size: v.int({ min: 0, optional: true }),
  }, o),
  any: (o = {}) => make((x) => x, o),
};

/** Valida el cuerpo completo contra un esquema de objeto. */
export function parse(schema, value, label = '') {
  return schema(value ?? {}, label);
}

/** Valida un parámetro de ruta numérico (ej. /tickets/:num). */
export function idParam(value, label = 'id') {
  if (!/^\d{1,10}$/.test(String(value || ''))) throw new ValidationError(`${label}: tiene que ser un número`, label);
  return Number(value);
}

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Control general de todo cuerpo JSON: profundidad, cantidad de claves y elementos,
 * y claves peligrosas (contaminación de prototipos).
 */
export function guardBody(body, { maxDepth = 12, maxKeys = 500, maxItems = 5000 } = {}) {
  const walk = (x, depth) => {
    if (depth > maxDepth) throw new ValidationError('El contenido está demasiado anidado', 'cuerpo');
    if (Array.isArray(x)) {
      if (x.length > maxItems) throw new ValidationError('Demasiados elementos en una lista', 'cuerpo');
      for (const el of x) walk(el, depth + 1);
      return;
    }
    if (x && typeof x === 'object') {
      const keys = Object.keys(x);
      if (keys.length > maxKeys) throw new ValidationError('Demasiados campos', 'cuerpo');
      for (const k of keys) {
        if (BAD_KEYS.has(k) || k.length > 200) throw new ValidationError('Nombre de campo no permitido', 'cuerpo');
        walk(x[k], depth + 1);
      }
    }
  };
  walk(body, 0);
  return body;
}

/** Contraseñas: largo, lista de claves comunes y que no contengan el usuario. */
const COMMON = new Set(['1234567890', '12345678910', 'qwertyuiop', 'contraseña1', 'password123', 'administrador', 'hanseatica1', 'hanseatica123', 'mesadeayuda', 'abcdefghij', 'iloveyou12', 'passw0rd123', 'aaaaaaaaaa']);
export function checkPasswordPolicy(pw, { email = '', name = '' } = {}) {
  const s = String(pw ?? '');
  if (s.length < 10) throw new ValidationError('La clave tiene que tener al menos 10 caracteres', 'password');
  if (s.length > 128) throw new ValidationError('La clave puede tener como máximo 128 caracteres', 'password');
  const low = s.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/.test(s) || /^\d+$/.test(s)) throw new ValidationError('Esa clave es demasiado común. Elegí otra.', 'password');
  const local = String(email).split('@')[0].toLowerCase();
  if (local.length >= 4 && low.includes(local)) throw new ValidationError('La clave no puede contener tu usuario', 'password');
  const first = String(name).split(' ')[0].toLowerCase();
  if (first.length >= 4 && low.includes(first)) throw new ValidationError('La clave no puede contener tu nombre', 'password');
  return s;
}

/** Término para LIKE/ILIKE: recorta y escapa % _ \ (que el usuario no pueda armar comodines). */
export function likeTerm(s, max = 200) {
  return `%${String(s ?? '').trim().slice(0, max).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
