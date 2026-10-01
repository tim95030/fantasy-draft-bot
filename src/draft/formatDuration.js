/**
 * Format a duration in seconds for humans.
 * Examples: 45 → "45s", 125 → "2m 5s", 3600 → "1h", 3665 → "1h 1m 5s"
 */
function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return '—';
  let total = Math.max(0, Math.ceil(Number(seconds)));
  if (total < 60) return `${total}s`;

  const hours = Math.floor(total / 3600);
  total %= 3600;
  const minutes = Math.floor(total / 60);
  const secs = total % 60;

  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  // Show seconds when under 1 hour, or when there are leftover seconds with hours
  if (secs && hours === 0) parts.push(`${secs}s`);
  else if (secs && hours > 0 && minutes === 0) parts.push(`${secs}s`);
  // For long clocks (e.g. 1h limit), prefer "54m 42s" style without noisy seconds when many hours?
  // Keep seconds whenever present under 2 hours for accuracy during a pick clock.
  if (secs && hours >= 1 && minutes > 0) parts.push(`${secs}s`);

  return parts.join(' ') || '0s';
}

module.exports = { formatDuration };
