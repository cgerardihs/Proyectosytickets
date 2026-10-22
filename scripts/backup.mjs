// Respaldo completo desde tu PC (sin el límite de 4,5 MB de Vercel):
//   DATABASE_URL="postgresql://..." npm run backup
import fs from 'node:fs';
import { buildBackup } from '../lib/routes/super.js';

const { sql, counts } = await buildBackup({ attachments: true });
const file = `mesa-de-ayuda-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.sql`;
fs.writeFileSync(file, sql);
console.log(`Respaldo guardado en ${file} (${(sql.length / 1048576).toFixed(1)} MB)`);
console.table(counts);
