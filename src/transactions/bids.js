const { formatSalary, parseSalary } = require('./format');

function parseBidMessage(content) {
  const text = String(content || '').trim();
  const amount = (() => {
    const m = text.match(/^\s*\$?\s*(\d[\d,]*(?:\.\d+)?)\s*([km])?(?![\w.])/i);
    if (!m) return null;
    return parseSalary(`${m[1]}${m[2] || ''}`);
  })();
  if (!amount) return null;
  const yearsMatch =
    text.match(/\bx\s*(\d)\s*(?:years?)?/i) ||
    text.match(/\((\d)\s*years?\)/i) ||
    text.match(/—\s*(\d)\s*years?\s*—/i);
  const years = yearsMatch ? Number(yearsMatch[1]) : null;
  return { amount, years };
}

/** @deprecated use parseBidMessage */
function parseBidFromMessage(content) {
  const p = parseBidMessage(content);
  return p?.amount ?? null;
}

function validateYears(years) {
  const y = Number(years);
  if (!Number.isInteger(y) || y < 1 || y > 6) {
    return 'Contract length must be an integer from **1** to **6** years.';
  }
  return null;
}

function validateBidAmount(amount, previousHigh, cfg) {
  const min = cfg.minBid ?? 850_000;
  const step = cfg.bidIncrement ?? 25_000;
  const minRaise = cfg.minRaise ?? 100_000;
  if (!Number.isFinite(amount) || amount < min) {
    return `Minimum bid is **${formatSalary(min)}**.`;
  }
  if (amount % step !== 0) {
    return `Bids must be in **${formatSalary(step)}** increments (e.g. ${formatSalary(min)}, ${formatSalary(min + step)}).`;
  }
  const high = Number(previousHigh) || 0;
  if (high > 0) {
    const need = high + minRaise;
    if (amount < need) {
      return `Must beat **${formatSalary(high)}** by at least **${formatSalary(minRaise)}** (minimum next bid **${formatSalary(need)}**).`;
    }
  }
  return null;
}

function formatBidLine(amount, years, userId, teamName) {
  return `${formatSalary(amount)} x ${years} years — <@${userId}> (${teamName})`;
}

module.exports = {
  parseBidMessage,
  parseBidFromMessage,
  validateYears,
  validateBidAmount,
  formatBidLine,
};
