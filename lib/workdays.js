// Días hábiles y horas estimadas de un proyecto (misma cuenta que hace el navegador en public/js/core.js).
export const DEFAULT_DAY_HOURS = 8;

/** Horas por día hábil para estimar proyectos (Configuración → Portfolio). */
export function dayHours(cfg) {
  const h = Number(cfg?.portfolio_day_hours);
  return h > 0 && h <= 24 ? h : DEFAULT_DAY_HOURS;
}

/** Días hábiles entre dos fechas AAAA-MM-DD, ambas incluidas (usa los días laborales y feriados del horario de atención). */
export function businessDays(start, end, cfg) {
  if (!start || !end || end < start) return 0;
  const days = cfg?.business?.days?.length ? cfg.business.days.map(Number) : [1, 2, 3, 4, 5];
  const holidays = new Set(cfg?.holidays || []);
  let n = 0;
  const last = Date.parse(`${end}T00:00:00Z`);
  for (let t = Date.parse(`${start}T00:00:00Z`), i = 0; t <= last && i < 3700; t += 86400000, i++) {
    const d = new Date(t);
    if (days.includes(d.getUTCDay()) && !holidays.has(d.toISOString().slice(0, 10))) n += 1;
  }
  return n;
}

/** Horas estimadas = días hábiles × horas por día. */
export function estimateHours(start, end, cfg) {
  return Math.round(businessDays(start, end, cfg) * dayHours(cfg) * 10) / 10;
}
