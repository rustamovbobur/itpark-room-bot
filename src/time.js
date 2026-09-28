export function localNow(now = new Date()) {
  // Uzbekistan uses UTC+5 without DST. ISO strings sort in calendar order.
  const local = new Date(now.getTime() + 5 * 3600000);
  return { day: local.toISOString().slice(0, 10), minute: local.getUTCHours() * 60 + local.getUTCMinutes() };
}
export function addDays(day, amount) {
  return new Date(Date.parse(day + 'T00:00:00Z') + amount * 86400000).toISOString().slice(0, 10);
}
export function validDay(day, now, horizon) {
  return typeof day==='string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(day + 'T00:00:00Z')) &&
    new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) === day &&
    day >= now.day && day < addDays(now.day, horizon);
}
export const time = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
export const date = day => day.split('-').reverse().join('.');
export function config(env) {
  const integer = (key, fallback, min, max) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error('Invalid configuration: ' + key);
    return value;
  };
  const open = integer('OPEN_HOUR', 8, 0, 23) * 60;
  const close = integer('CLOSE_HOUR', 20, 1, 24) * 60;
  if (close <= open) throw new Error('Invalid office hours');
  return {open, close, horizon: integer('BOOKING_DAYS',30,1,90), maxDuration:integer('MAX_DURATION_HOURS',4,1,12)*60};
}
export function validRange(day, start, end, now, cfg) {
  return validDay(day,now,cfg.horizon) && Number.isInteger(start) && Number.isInteger(end) &&
    start % 30 === 0 && end % 30 === 0 && start >= cfg.open && end <= cfg.close &&
    end > start && end-start <= cfg.maxDuration && (day > now.day || start > now.minute);
}
