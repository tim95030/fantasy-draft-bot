const { formatSalary, parseSalary } = require('./format');

function parseBidMessage(content) {
  const text = String(content || '').trim();
  const m = text.match(/^\s*\$?\s*(\d[\d,]*(?:\.\d+)?)\s*([km])?(?![\w.])/i);
  if (!m) return null;
  const amount = parseSalary(`${m[1]}${m[2] || ''}`);
  return amount ? { amount } : null;
}

/** @deprecated use parseBidMessage */
function parseBidFromMessage(content) {
  const p = parseBidMessage(content);
  return p?.amount ?? null;
}

/** Winner reply after auction: `3`, `3 years`, `6 year`. */
function parseContractYears(content) {
  const text = String(content || '').trim();
  const m = text.match(/^(\d)\s*(?:year|years|yr|yrs)?\.?\s*$/i);
  if (!m) return null;
  const y = Number(m[1]);
  return y >= 1 && y <= 6 ? y : null;
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

function formatBidLine(amount, userId, teamName) {
  return `${formatSalary(amount)} — <@${userId}> (${teamName})`;
}

module.exports = {
  parseBidMessage,
  parseBidFromMessage,
  parseContractYears,
  validateYears,
  validateBidAmount,
  formatBidLine,
};
