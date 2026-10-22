// Build de Vercel: aplica las migraciones pendientes ANTES de que el código nuevo reciba tráfico.
// Las migraciones solo agregan (expandir/contraer), así que el código anterior sigue funcionando mientras tanto.
// Si todavía no hay DATABASE_URL (primer despliegue), no hace nada: la instalación crea las tablas.
import { scan } from './check-secrets.mjs';

const found = scan();
if (found.length) {
  for (const [f, n] of found) console.error(`✗ ${f}: ${n}`);
  console.error('Se encontraron secretos en el código: se cancela el despliegue.');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.log('Sin DATABASE_URL: se omiten las migraciones.');
  process.exit(0);
}
const { migrate } = await import('../lib/migrate.js');
const v = await migrate();
console.log(`Migraciones al día (versión ${v}).`);
process.exit(0);
