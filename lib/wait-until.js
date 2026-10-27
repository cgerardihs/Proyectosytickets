// Trabajo que sigue después de responder (v1.13.3).
// En Vercel, apenas la función responde, la instancia se congela: una promesa que quedó corriendo se detiene a mitad
// de camino y recién sigue (si sigue) con la próxima petición. waitUntil le pide a Vercel que espere a que termine.
// Es lo mismo que hace @vercel/functions, sin sumar la dependencia. Fuera de Vercel (desarrollo, pruebas) no hace nada.
export function waitUntil(promise) {
  const p = Promise.resolve(promise).catch(() => {});
  try {
    const ctx = globalThis[Symbol.for('@vercel/request-context')]?.get?.();
    if (ctx && typeof ctx.waitUntil === 'function') { ctx.waitUntil(p); return true; }
  } catch { /* sin contexto de Vercel */ }
  return false;
}
