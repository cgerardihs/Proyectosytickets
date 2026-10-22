// Cálculo de vencimientos de SLA con horario laboral, feriados y zona horaria.

function tzOffsetMinutes(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

const toWall = (ms, tz) => ms + tzOffsetMinutes(new Date(ms), tz) * 60000;
const fromWall = (wallMs, tz) => {
  const guess = wallMs - tzOffsetMinutes(new Date(wallMs), tz) * 60000;
  return wallMs - tzOffsetMinutes(new Date(guess), tz) * 60000;
};

const hm = (s, def) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || def));
  return m ? [+m[1], +m[2]] : hm(def, '09:00');
};

/** Suma minutos hábiles a una fecha. cfg = { timezone, business:{days,start,end}, holidays:[] } */
export function addBusinessMinutes(start, minutes, cfg) {
  const tz = cfg?.timezone || 'America/Argentina/Buenos_Aires';
  const days = cfg?.business?.days?.length ? cfg.business.days.map(Number) : [1, 2, 3, 4, 5];
  const [sh, sm] = hm(cfg?.business?.start, '09:00');
  const [eh, em] = hm(cfg?.business?.end, '18:00');
  const holidays = new Set(cfg?.holidays || []);
  let remaining = minutes;
  let cur = toWall(new Date(start).getTime(), tz);
  for (let i = 0; i < 800; i++) {
    const d = new Date(cur);
    const y = d.getUTCFullYear(), mo = d.getUTCMonth(), da = d.getUTCDate();
    const iso = d.toISOString().slice(0, 10);
    const dayStart = Date.UTC(y, mo, da, sh, sm);
    const dayEnd = Date.UTC(y, mo, da, eh, em);
    if (days.includes(d.getUTCDay()) && !holidays.has(iso) && dayEnd > dayStart) {
      if (cur < dayStart) cur = dayStart;
      if (cur < dayEnd) {
        const avail = (dayEnd - cur) / 60000;
        if (remaining <= avail) return new Date(fromWall(cur + remaining * 60000, tz));
        remaining -= avail;
      }
    }
    cur = Date.UTC(y, mo, da + 1, 0, 0);
  }
  return new Date(new Date(start).getTime() + minutes * 60000);
}

export function addMinutes(start, minutes, cfg, businessHours) {
  if (!businessHours) return new Date(new Date(start).getTime() + minutes * 60000);
  return addBusinessMinutes(start, minutes, cfg);
}

/** Devuelve { first_response_due, resolution_due } para un ticket. */
export function computeDues(createdAt, priority, policy, cfg) {
  if (!policy || policy.no_sla) return { first_response_due: null, resolution_due: null };
  const t = policy.targets?.[String(priority)] || policy.targets?.[priority];
  if (!t) return { first_response_due: null, resolution_due: null };
  const first = Number(t.first) > 0 ? addMinutes(createdAt, Number(t.first) * 60, cfg, policy.business_hours) : null;
  const resolve = Number(t.resolve) > 0 ? addMinutes(createdAt, Number(t.resolve) * 60, cfg, policy.business_hours) : null;
  return { first_response_due: first, resolution_due: resolve };
}
