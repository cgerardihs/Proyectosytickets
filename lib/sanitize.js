// Sanitizado de HTML del lado del servidor (lista blanca). Es una segunda barrera: el navegador también sanitiza al mostrar.
const ALLOWED = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'a', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'h1', 'h2', 'h3', 'h4',
  'table', 'thead', 'tbody', 'tr', 'td', 'th', 'img', 'span', 'div', 'hr', 'sub', 'sup', 'font', 'center', 'small']);
const DROP_WITH_CONTENT = ['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'noscript', 'head', 'title', 'xml', 'textarea', 'select', 'frameset', 'frame', 'applet'];
const ATTRS = { a: ['href', 'title'], img: ['src', 'alt', 'title', 'width', 'height'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] };
const COMMON_ATTRS = ['title'];

// Un número de entidad fuera de Unicode (ej. &#9999999;) no puede tirar error: un solo correo así frenaría la entrada de tickets
const cp = (n) => String.fromCodePoint(Number.isInteger(n) && n > 0 && n <= 0x10FFFF && !(n >= 0xD800 && n <= 0xDFFF) ? n : 0xFFFD);

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]{1,8});?/gi, (_, h) => cp(Number.parseInt(h, 16)))
    .replace(/&#(\d{1,10});?/g, (_, d) => cp(Number(d)))
    .replace(/&colon;/gi, ':').replace(/&tab;/gi, '').replace(/&newline;/gi, '')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function safeUrl(tag, value) {
  // eslint-disable-next-line no-control-regex
  const v = decodeEntities(value).replace(/[\u0000- \u007F]+/g, '').toLowerCase();
  if (tag === 'img') return /^https:/.test(v) || /^data:image\/(png|jpe?g|gif|webp);base64,/.test(v);
  return /^(https?:|mailto:|#|\/(?!\/))/.test(v);
}

const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function sanitizeHtml(input) {
  let html = String(input ?? '');
  html = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, '').replace(/<!doctype[^>]*>/gi, '').replace(/<\?[\s\S]*?\?>/g, '');
  for (let i = 0; i < 3; i += 1) {
    for (const t of DROP_WITH_CONTENT) html = html.replace(new RegExp(`<${t}\\b[\\s\\S]*?(<\\/${t}\\s*>|$)`, 'gi'), '');
  }
  return html.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|</g, (m, close, name, rest) => {
    if (m === '<') return '&lt;';
    const tag = name.toLowerCase();
    if (!ALLOWED.has(tag)) return '';
    if (close) return `</${tag}>`;
    const allowed = new Set([...(ATTRS[tag] || []), ...COMMON_ATTRS]);
    const out = [];
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let a;
    while ((a = re.exec(rest))) {
      const attr = a[1].toLowerCase();
      const val = a[2] ?? a[3] ?? a[4] ?? '';
      if (!allowed.has(attr)) continue;
      if ((attr === 'href' || attr === 'src') && !safeUrl(tag, val)) continue;
      if ((attr === 'width' || attr === 'height' || attr === 'colspan' || attr === 'rowspan') && !/^\d{1,4}$/.test(val)) continue;
      out.push(`${attr}="${escAttr(decodeEntities(val))}"`);
    }
    if (tag === 'a') out.push('rel="noopener noreferrer"', 'target="_blank"');
    return `<${tag}${out.length ? ` ${out.join(' ')}` : ''}${/\/\s*$/.test(rest) && ['br', 'hr', 'img'].includes(tag) ? ' /' : ''}>`;
  });
}
