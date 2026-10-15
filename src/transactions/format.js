const ROOKIE_SALARY = {
  first: 850_000,
  second: 1_100_000,
  third: 1_500_000,
  'rfa 1': 3_000_000,
  'rfa 2': 6_000_000,
  'rfa 3': 9_000_000,
};

/**
 * `850k`, `1.2m`, `$1,200,000` → dollars. Bare numbers under 1000 are rejected
 * (ambiguous between thousands and millions).
 */
function parseSalary(text) {
  const m = String(text || '')
    .trim()
    .replace(/^\$/, '')
    .replace(/,/g, '')
    .match(/^(\d+(?:\.\d+)?)\s*([km])?$/i);
  if (!m) return null;
  const value = Number(m[1]);
  const unit = (m[2] || '').toLowerCase();
  if (!Number.isFinite(value)) return null;
  if (unit === 'k') return Math.round(value * 1_000);
  if (unit === 'm') return Math.round(value * 1_000_000);
  return value >= 1000 ? Math.round(value) : null;
}

/** Amount at the start of a thread message (`900k`, `1.1m — @user`). */
function parseBidFromMessage(content) {
  const { parseBidFromMessage: parse } = require('./bids');
  return parse(content);
}

function trimNumber(n, digits) {
  return String(Number(n.toFixed(digits)));
}

/** 850000 → `850k`, 1100000 → `1.1m`, 3000000 → `3m`. */
function formatSalary(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1_000_000) return `${trimNumber(n / 1_000_000, 3)}m`;
  return `${trimNumber(n / 1_000, 1)}k`;
}

/** `4 years @ 3m`, `First @ 850k`, `Minors (no cap hit)`. */
function contractLabel(item) {
  const name = String(item?.contract || '').trim();
  if (name.toLowerCase() === 'minors') {
    return 'Minors (no cap hit)';
  }
  const years = /^\d+$/.test(name) ? Number(name) : null;
  const label = years != null ? `${years} year${years === 1 ? '' : 's'}` : name || 'Contract';
  const rookieKey = name.toLowerCase();
  const salary = item?.salary || ROOKIE_SALARY[rookieKey] || null;
  return salary ? `${label} @ ${formatSalary(salary)}` : label;
}

/** `Joe Smith RW, ANA` */
function playerLabel(p) {
  const pos = p?.position ? ` ${p.position}` : '';
  const team = p?.team ? `, ${p.team}` : '';
  return `${p?.name || 'Unknown'}${pos}${team}`;
}

module.exports = {
  ROOKIE_SALARY,
  parseSalary,
  parseBidFromMessage,
  formatSalary,
  contractLabel,
  playerLabel,
};
