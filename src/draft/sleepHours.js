/**
 * Quiet-hours / sleep-window helpers.
 * Times are "HH:MM" (24h) in an IANA timezone, e.g. America/Los_Angeles.
 */

/** Common North American zones for autocomplete (IANA ids). */
const NORTH_AMERICA_TIMEZONES = [
  { id: 'America/St_Johns', label: 'Newfoundland' },
  { id: 'America/Halifax', label: 'Atlantic (Halifax)' },
  { id: 'America/New_York', label: 'Eastern (New York)' },
  { id: 'America/Toronto', label: 'Eastern (Toronto)' },
  { id: 'America/Detroit', label: 'Eastern (Detroit)' },
  { id: 'America/Indiana/Indianapolis', label: 'Eastern (Indiana)' },
  { id: 'America/Chicago', label: 'Central (Chicago)' },
  { id: 'America/Winnipeg', label: 'Central (Winnipeg)' },
  { id: 'America/Mexico_City', label: 'Central (Mexico City)' },
  { id: 'America/Denver', label: 'Mountain (Denver)' },
  { id: 'America/Edmonton', label: 'Mountain (Edmonton)' },
  { id: 'America/Phoenix', label: 'Arizona (no DST)' },
  { id: 'America/Los_Angeles', label: 'Pacific (Los Angeles)' },
  { id: 'America/Vancouver', label: 'Pacific (Vancouver)' },
  { id: 'America/Anchorage', label: 'Alaska (Anchorage)' },
  { id: 'Pacific/Honolulu', label: 'Hawaii (Honolulu)' },
];

function parseHm(hm) {
  const m = String(hm || '')
    .trim()
    .match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function formatHm(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function isValidTimeZone(tz) {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Current UTC offset string for a zone, e.g. "UTC-7" / "UTC-4". */
function utcOffsetLabel(timeZone, date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'shortOffset',
    }).formatToParts(date);
    const raw = parts.find((p) => p.type === 'timeZoneName')?.value || '';
    const m = raw.replace('GMT', 'UTC').match(/UTC([+-])(\d{1,2})(?::?(\d{2}))?/i);
    if (m) {
      const sign = m[1];
      const hh = String(Number(m[2]));
      const mm = m[3] && m[3] !== '00' ? `:${m[3]}` : '';
      return `UTC${sign}${hh}${mm}`;
    }
    const a = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
    const b = new Date(date.toLocaleString('en-US', { timeZone }));
    const diffMin = Math.round((b - a) / 60000);
    const sign = diffMin >= 0 ? '+' : '-';
    const abs = Math.abs(diffMin);
    const oh = Math.floor(abs / 60);
    const om = abs % 60;
    return om ? `UTC${sign}${oh}:${String(om).padStart(2, '0')}` : `UTC${sign}${oh}`;
  } catch {
    return 'UTC?';
  }
}

function timezoneChoiceLabel(entry, date = new Date()) {
  const offset = utcOffsetLabel(entry.id, date);
  return `${entry.label} · ${offset}`.slice(0, 100);
}

function searchNorthAmericaTimezones(query, limit = 25) {
  const q = String(query || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const now = new Date();
  const scored = [];
  for (const entry of NORTH_AMERICA_TIMEZONES) {
    const hay = `${entry.label} ${entry.id} ${utcOffsetLabel(entry.id, now)}`.toLowerCase();
    let score = 0;
    if (!q) score = 1;
    else if (entry.id.toLowerCase() === q) score = 100;
    else if (entry.label.toLowerCase().startsWith(q)) score = 90;
    else if (hay.includes(q)) score = 70;
    else if (q.split(' ').every((part) => hay.includes(part))) score = 50;
    else continue;
    scored.push({ score, entry });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label));
  return scored.slice(0, limit).map((s) => ({
    name: timezoneChoiceLabel(s.entry, now),
    value: s.entry.id.slice(0, 100),
  }));
}

function minutesNowInZone(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
  return hour * 60 + minute;
}

function isInSleepWindow(config, date = new Date()) {
  if (!config?.sleepEnabled) return false;
  const tz = config.sleepTimezone || 'America/Los_Angeles';
  const start = parseHm(config.sleepStart);
  const end = parseHm(config.sleepEnd);
  if (start == null || end == null) return false;
  if (start === end) return false;

  const now = minutesNowInZone(tz, date);
  if (start < end) {
    return now >= start && now < end;
  }
  return now >= start || now < end;
}

function sleepWindowLabel(config) {
  if (!config?.sleepEnabled) return 'Sleep hours off';
  const tz = config.sleepTimezone || 'America/Los_Angeles';
  const offset = isValidTimeZone(tz) ? utcOffsetLabel(tz) : '';
  const known = NORTH_AMERICA_TIMEZONES.find((z) => z.id === tz);
  const nice = known ? known.label : tz;
  return `${config.sleepStart}–${config.sleepEnd} (${nice}${offset ? `, ${offset}` : ''})`;
}

function nextSleepEndDate(config, date = new Date()) {
  if (!config?.sleepEnabled) return null;
  const end = parseHm(config.sleepEnd);
  if (end == null) return null;

  const cursor = new Date(date.getTime());
  for (let i = 0; i < 60 * 25; i += 1) {
    cursor.setMinutes(cursor.getMinutes() + 1);
    if (!isInSleepWindow(config, cursor)) return cursor;
  }
  return null;
}

function formatInZone(date, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

module.exports = {
  NORTH_AMERICA_TIMEZONES,
  parseHm,
  formatHm,
  isValidTimeZone,
  utcOffsetLabel,
  timezoneChoiceLabel,
  searchNorthAmericaTimezones,
  minutesNowInZone,
  isInSleepWindow,
  sleepWindowLabel,
  nextSleepEndDate,
  formatInZone,
};
