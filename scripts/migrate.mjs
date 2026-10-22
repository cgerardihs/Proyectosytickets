// Crea o actualiza las tablas en Neon aplicando las migraciones pendientes:
//   DATABASE_URL=... npm run migrate           aplica
//   DATABASE_URL=... npm run migrate -- --status   muestra el estado
import { migrate, migrationStatus } from '../lib/migrate.js';

if (process.argv.includes('--status')) {
  const s = await migrationStatus();
  console.log(`Versión aplicada: ${s.current} · última: ${s.latest} · pendientes: ${s.pending.join(', ') || 'ninguna'}`);
  for (const a of s.applied) console.log(`  ${a.version}  ${new Date(a.applied_at).toISOString()}  ${a.name}`);
} else {
  const v = await migrate();
  console.log(`Esquema actualizado (versión ${v}).`);
}
process.exit(0);
