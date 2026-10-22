// Lector de CSV (RFC 4180): comillas, comillas dobles, saltos de línea dentro de campos, BOM y separador , o ;
// Una sola pasada por caracteres (sin expresiones regulares que vuelvan a escanear).
const MAX = 12 * 1024 * 1024;

export function parseCsv(input, { maxRows = 50000, maxCols = 300 } = {}) {
  let text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input || '');
  if (text.length > MAX) throw new Error('El archivo es demasiado grande');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // Separador: el que más aparece en la primera línea fuera de comillas (coma, punto y coma o tabulación)
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQ = false;
  for (let i = 0; i < text.length && i < 20000; i++) {
    const c = text[i];
    if (c === '"') inQ = !inQ;
    else if (!inQ && (c === '\n' || c === '\r')) break;
    else if (!inQ && c in counts) counts[c]++;
  }
  const sep = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0 ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') { quoted = true; continue; }
    if (c === sep) { row.push(field); field = ''; if (row.length > maxCols) throw new Error('El archivo tiene demasiadas columnas'); continue; }
    if (c === '\r') continue;
    if (c === '\n') {
      row.push(field);
      if (row.some((x) => x !== '')) rows.push(row);
      if (rows.length > maxRows) throw new Error('El archivo tiene demasiadas filas');
      row = [];
      field = '';
      continue;
    }
    field += c;
  }
  row.push(field);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}
