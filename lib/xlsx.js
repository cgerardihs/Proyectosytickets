// Lectura y escritura mínima de archivos Excel (.xlsx) sin dependencias: un .xlsx es un ZIP con XML adentro.
// Lee la primera hoja (texto, números, fechas y fórmulas ya calculadas) y escribe hojas simples con formato.
import zlib from 'node:zlib';

// ---------- ZIP ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const MAX_ENTRY = 40 * 1024 * 1024; // tope por archivo descomprimido (evita "zip bombs")

/** Devuelve un Map nombre → Buffer con los archivos del ZIP. */
export function unzip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('El archivo no es un Excel válido');
  // Fin del directorio central: firma 0x06054b50, buscando desde el final
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('El archivo no es un Excel válido (.xlsx)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  let total = 0;
  for (let n = 0; n < count && n < 2000; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('El archivo Excel está dañado');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    if (usize > MAX_ENTRY) throw new Error('El archivo Excel es demasiado grande');
    const lnlen = buf.readUInt16LE(local + 26);
    const lelen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lnlen + lelen;
    const data = buf.subarray(start, start + csize);
    let out;
    if (method === 0) out = Buffer.from(data);
    else if (method === 8) out = zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY });
    else continue;
    total += out.length;
    if (total > 4 * MAX_ENTRY) throw new Error('El archivo Excel es demasiado grande');
    files.set(name, out);
  }
  return files;
}

/** Arma un ZIP (deflate) con [{ name, data }]. */
export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const comp = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---------- XML ----------
const decode = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  const k = e.toLowerCase();
  if (k === 'amp') return '&';
  if (k === 'lt') return '<';
  if (k === 'gt') return '>';
  if (k === 'quot') return '"';
  if (k === 'apos') return "'";
  const code = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
  return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
});
const encode = (s) => String(s ?? '')
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const MAX_XML = 12 * 1024 * 1024; // tope de cada XML que se analiza

/**
 * Recorre los elementos <tag …>…</tag> (o <tag …/>) en una sola pasada hacia adelante, con indexOf
 * (sin expresiones regulares que vuelvan a escanear: un archivo malicioso no puede trabar el servidor).
 * cb(attrs, inner) — inner es null si el elemento se cierra solo.
 */
function eachElement(xml, tag, cb, { limit = 1e6 } = {}) {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let i = 0;
  let n = 0;
  while (n < limit) {
    let start = xml.indexOf(open, i);
    if (start < 0) return;
    const next = xml.charCodeAt(start + open.length);
    // Tiene que ser exactamente la etiqueta (no <tagX): sigue espacio, ">" o "/"
    if (!(next === 32 || next === 62 || next === 47 || next === 9 || next === 10 || next === 13)) { i = start + open.length; continue; }
    const gt = xml.indexOf('>', start);
    if (gt < 0) return;
    const selfClosing = xml.charCodeAt(gt - 1) === 47;
    const attrs = xml.slice(start + open.length, selfClosing ? gt - 1 : gt);
    if (selfClosing) { cb(attrs, null); i = gt + 1; n++; continue; }
    const end = xml.indexOf(close, gt + 1);
    if (end < 0) return; // sin cierre: se corta acá (no se reintenta desde cada apertura)
    cb(attrs, xml.slice(gt + 1, end));
    i = end + close.length;
    n++;
    start = i;
  }
}
const attr = (attrs, name) => {
  const a = ` ${attrs.replace(/\s+/g, ' ')}`;
  const k = ` ${name}="`;
  const s = a.indexOf(k);
  if (s < 0) return undefined;
  const from = s + k.length;
  const to = a.indexOf('"', from);
  return to < 0 ? undefined : a.slice(from, to);
};
/** Texto de un <si> o <is> (con o sin formato enriquecido). */
function richText(xml) {
  const parts = [];
  eachElement(xml, 't', (_a, inner) => { if (inner !== null) parts.push(decode(inner)); }, { limit: 5000 });
  return parts.join('');
}
const firstInner = (xml, tag) => {
  let out;
  eachElement(xml, tag, (_a, inner) => { if (out === undefined) out = inner ?? ''; }, { limit: 1 });
  return out;
};

/** Índice de columna desde la referencia ("C7" → 2). */
function colIndex(ref) {
  let n = 0;
  for (const ch of String(ref).toUpperCase()) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return Math.max(0, n - 1);
}

// Formatos de número que son fechas (los integrados de Excel y los personalizados con d/m/y)
const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

/**
 * Lee la primera hoja (o la que se indique por nombre) y devuelve una matriz de filas.
 * Las fechas vuelven como objetos { date: 'AAAA-MM-DD' }; los números, como número; el resto, como texto.
 */
export function readXlsx(buf, { sheet = null } = {}) {
  const files = unzip(buf);
  const text = (n) => {
    const b = files.get(n);
    if (!b) return '';
    if (b.length > MAX_XML) throw new Error('La planilla es demasiado grande para importarla');
    return b.toString('utf8');
  };
  const shared = [];
  eachElement(text('xl/sharedStrings.xml'), 'si', (_a, inner) => shared.push(richText(inner || '')), { limit: 200000 });
  // Estilos: qué índices de estilo son fechas
  const styles = text('xl/styles.xml');
  const customFmts = new Map();
  eachElement(styles, 'numFmt', (a) => customFmts.set(Number(attr(a, 'numFmtId')), decode(attr(a, 'formatCode') || '')), { limit: 1000 });
  const xfDate = [];
  eachElement(firstInner(styles, 'cellXfs') || '', 'xf', (a) => {
    const id = Number(attr(a, 'numFmtId') || 0);
    const code = customFmts.get(id);
    xfDate.push(BUILTIN_DATE.has(id) || Boolean(code && /[dmy]/i.test(code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '')) && !/^[#0.,%\s]+$/.test(code)));
  }, { limit: 5000 });
  // Hoja: la indicada, o la primera del libro
  const sheets = [];
  eachElement(text('xl/workbook.xml'), 'sheet', (a) => sheets.push({ name: decode(attr(a, 'name') || ''), rid: attr(a, 'r:id') }), { limit: 500 });
  const rels = new Map();
  eachElement(text('xl/_rels/workbook.xml.rels'), 'Relationship', (a) => rels.set(attr(a, 'Id'), attr(a, 'Target')), { limit: 1000 });
  const chosen = (sheet && sheets.find((s) => s.name.toLowerCase() === String(sheet).toLowerCase())) || sheets[0];
  let path = 'xl/worksheets/sheet1.xml';
  const target = chosen && rels.get(chosen.rid);
  if (target) path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  const xml = text(path);
  if (!xml) throw new Error('No se encontró la hoja en el archivo Excel');
  const rows = [];
  eachElement(firstInner(xml, 'sheetData') ?? xml, 'row', (ra, rowXml) => {
    const r = Number(attr(ra, 'r') || rows.length + 1) - 1;
    if (!Number.isInteger(r) || r < 0 || r > 20000) return;
    const row = [];
    eachElement(rowXml || '', 'c', (attrs, inner) => {
      const ref = attr(attrs, 'r');
      const c = ref ? colIndex(ref) : row.length;
      if (c > 200) return;
      const t = attr(attrs, 't');
      const st = Number(attr(attrs, 's') || 0);
      const body = inner || '';
      const vRaw = firstInner(body, 'v');
      let val = null;
      if (t === 's') val = shared[Number(vRaw)] ?? '';
      else if (t === 'inlineStr') val = richText(firstInner(body, 'is') || '');
      else if (t === 'str' || t === 'e') val = vRaw === undefined ? '' : decode(vRaw);
      else if (t === 'b') val = vRaw === '1';
      else if (vRaw !== undefined) {
        const num = Number(vRaw);
        val = Number.isFinite(num) && xfDate[st] ? { date: serialToIso(num) } : Number.isFinite(num) ? num : decode(vRaw);
      }
      row[c] = val;
    }, { limit: 300 });
    rows[r] = row;
  }, { limit: 20001 });
  return Array.from(rows, (x) => x || []);
}

/** Número de serie de Excel (sistema 1900) → AAAA-MM-DD. */
export function serialToIso(n) {
  const v = Number(n);
  // Fuera de 1900–2200 no es una fecha razonable
  if (!Number.isFinite(v) || v < 1 || v > 110000) return null;
  return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
}
const isoToSerial = (iso) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86400000 + 25569;

const colName = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/**
 * Escribe un .xlsx. sheets: [{ name, columns: [{ header, width, type: 'text'|'number'|'date'|'percent'|'hours' }], rows: [[...]] }]
 * Encabezado en negrita, fila fija y autofiltro.
 */
export function writeXlsx(sheets) {
  // Estilos: 0 normal · 1 encabezado · 2 fecha · 3 porcentaje · 4 número con decimales · 5 texto con ajuste de línea
  const STYLE = { text: 5, number: 0, date: 2, percent: 3, hours: 4 };
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>
<fonts count="2"><font><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F2937"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  const sheetXml = (sh) => {
    const cols = sh.columns;
    const head = `<row r="1">${cols.map((c, i) => `<c r="${colName(i)}1" t="inlineStr" s="1"><is><t>${encode(c.header)}</t></is></c>`).join('')}</row>`;
    const body = sh.rows.map((row, ri) => {
      const r = ri + 2;
      return `<row r="${r}">${cols.map((c, ci) => {
        const val = row[ci];
        const ref = `${colName(ci)}${r}`;
        if (val === null || val === undefined || val === '') return '';
        if (c.type === 'date') {
          const iso = String(val).slice(0, 10);
          if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return `<c r="${ref}" s="2"><v>${isoToSerial(iso)}</v></c>`;
        }
        if (['number', 'percent', 'hours'].includes(c.type) && Number.isFinite(Number(val))) return `<c r="${ref}" s="${STYLE[c.type]}"><v>${Number(val)}</v></c>`;
        return `<c r="${ref}" t="inlineStr" s="5"><is><t xml:space="preserve">${encode(String(val).slice(0, 32000))}</t></is></c>`;
      }).join('')}</row>`;
    }).join('');
    const last = `${colName(Math.max(0, cols.length - 1))}${sh.rows.length + 1}`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}" customWidth="1"/>`).join('')}</cols>
<sheetData>${head}${body}</sheetData>
<autoFilter ref="A1:${last}"/>
</worksheet>`;
  };
  const safeName = (n, i) => String(n || `Hoja${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);
  const entries = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${encode(safeName(s.name, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
<definedNames>${sheets.map((s, i) => `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${encode(safeName(s.name, i)).replace(/'/g, "''")}'!$A$1:$${colName(Math.max(0, s.columns.length - 1))}$${s.rows.length + 1}</definedName>`).join('')}</definedNames></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: styles },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ];
  return zip(entries);
}

/**
 * Celda de CSV segura: si empieza con =, +, -, @, tabulación o retorno (y no es un número), se antepone ' para que
 * Excel la trate como texto y no ejecute una fórmula (CSV injection). Todas las exportaciones usan esta función.
 */
export function csvCell(x) {
  if (x === null || x === undefined) return '';
  const s = x instanceof Date ? x.toISOString() : Array.isArray(x) ? x.join('|') : typeof x === 'object' ? JSON.stringify(x) : String(x);
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** CSV con BOM (Excel lo abre con acentos bien). */
export function toCsv(rows) {
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}
