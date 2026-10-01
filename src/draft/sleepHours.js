/**
 * Quiet-hours / sleep-window helpers.
 * Times are "HH:MM" (24h) in an IANA timezone, e.g. America/Los_Angeles.
 */

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

/** Minutes since midnight in the given IANA timezone. */
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

/**
 * True when current local time in `timeZone` is inside [start, end).
 * Supports windows that cross midnight (e.g. 22:00 → 08:00).
 */
function isInSleepWindow(config, date = new Date()) {
  if (!config?.sleepEnabled) return false;
  const tz = config.sleepTimezone || 'America/Los_Angeles';
  const start = parseHm(config.sleepStart);
  const end = parseHm(config.sleepEnd);
  if (start == null || end == null) return false;
  if (start === end) return false; // zero-length / invalid

  const now = minutesNowInZone(tz, date);
  if (start < end) {
    return now >= start && now < end;
  }
  // Crosses midnight: e.g. 22:00–08:00
  return now >= start || now < end;
}

function sleepWindowLabel(config) {
  if (!config?.sleepEnabled) return 'Sleep hours off';
  const tz = config.sleepTimezone || 'America/Los_Angeles';
  return `${config.sleepStart}–${config.sleepEnd} (${tz})`;
}

/**
 * Next Date when sleep ends (approximate, within ~1 day).
 */
function nextSleepEndDate(config, date = new Date()) {
  if (!config?.sleepEnabled) return null;
  const tz = config.sleepTimezone || 'America/Los_Angeles';
  const end = parseHm(config.sleepEnd);
  if (end == null) return null;

  // Walk minute-by-minute up to 25h — simple and correct across DST edges
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
  parseHm,
  formatHm,
  isValidTimeZone,
  minutesNowInZone,
  isInSleepWindow,
  sleepWindowLabel,
  nextSleepEndDate,
  formatInZone,
};
