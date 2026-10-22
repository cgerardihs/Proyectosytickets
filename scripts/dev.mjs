// Servidor local: sirve /public y enruta /api/* a la función, con PGlite si no hay DATABASE_URL.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.DATABASE_URL && !process.env.PGLITE) process.env.PGLITE = path.join(root, '.pglite');
const { default: handler } = await import('../api/router.js');

// Mismos encabezados de seguridad que vercel.json, para probar localmente igual que en producción.
const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const SEC_HEADERS = (vercel.headers?.[0]?.headers || []).filter((h) => !/Strict-Transport|upgrade/i.test(h.key));
const csp = SEC_HEADERS.find((h) => h.key === 'Content-Security-Policy');
if (csp) csp.value = csp.value.replace('; upgrade-insecure-requests', '');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const port = Number(process.env.PORT || 3000);

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  for (const h of SEC_HEADERS) res.setHeader(h.key, h.value);
  if (url.pathname.startsWith('/api/')) return handler(req, res);
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  if (!path.extname(file)) file += '.html';
  const full = path.join(root, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(full, (err, data) => {
    if (err) { res.statusCode = 404; return res.end('No encontrado'); }
    res.setHeader('Content-Type', TYPES[path.extname(full)] || 'application/octet-stream');
    res.end(data);
  });
}).listen(port, () => console.log(`Mesa de ayuda en http://localhost:${port} (${process.env.DATABASE_URL ? 'Neon' : 'PGlite local'})`));
