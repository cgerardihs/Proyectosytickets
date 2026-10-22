// Busca secretos en el código antes de publicar: claves de API, contraseñas en cadenas de conexión, llaves privadas.
//   npm run check:secrets
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.pglite', '.vercel']);
const PATTERNS = [
  ['Clave de Resend', /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}\b/],
  ['Clave de Anthropic', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['Clave de OpenAI', /\bsk-(proj-)?[A-Za-z0-9]{32,}/],
  ['Clave de Google', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Token de GitHub', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Llave privada', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Cadena de conexión con clave', /postgres(ql)?:\/\/[^:\s'"`]+:(?!clave@|password@|usuario@|\$\{)[^@\s'"`]{6,}@[^\s'"`]*neon\.tech/],
  ['Secreto de Entra ID', /\b[A-Za-z0-9_]{3}8Q~[A-Za-z0-9_.~-]{31,}\b/],
  ['Variable de entorno con valor', /^(SESSION_SECRET|SUPERADMIN_PASSWORD|MS_CLIENT_SECRET|AI_API_KEY|RESEND_API_KEY|INBOUND_SECRET|CRON_SECRET)=\S{8,}/m],
];

export function scan(dir = root) {
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (/\.(png|jpe?g|gif|ico|zip|gz|woff2?|lock)$/i.test(e.name) || e.name === 'package-lock.json') continue;
      if (/^\.env(\..+)?$/.test(e.name) && e.name !== '.env.example') { found.push([path.relative(root, full), 'Archivo .env dentro del proyecto']); continue; }
      const text = fs.readFileSync(full, 'utf8');
      for (const [name, re] of PATTERNS) if (re.test(text)) found.push([path.relative(root, full), name]);
    }
  };
  walk(dir);
  return found;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const found = scan();
  if (found.length) {
    for (const [f, n] of found) console.error(`✗ ${f}: ${n}`);
    process.exit(1);
  }
  console.log('Sin secretos en el código.');
}
