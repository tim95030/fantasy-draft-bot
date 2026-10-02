const fs = require('fs');
const paths = require('../paths');

/**
 * Append-only JSONL audit trail for draft/queue debugging.
 * One JSON object per line in data/audit.jsonl.
 */
function audit(event, details = {}) {
  const row = {
    at: new Date().toISOString(),
    event: String(event),
    ...details,
  };
  try {
    if (!fs.existsSync(paths.DATA)) fs.mkdirSync(paths.DATA, { recursive: true });
    fs.appendFileSync(paths.AUDIT_LOG, `${JSON.stringify(row)}\n`);
  } catch (err) {
    console.error('audit write failed:', err.message);
  }
  return row;
}

module.exports = { audit };
