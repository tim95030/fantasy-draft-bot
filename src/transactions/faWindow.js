const { txnConfig } = require('./common');

function faWindowError(cfg = txnConfig()) {
  if (!cfg.enforceFaWindow) return null;
  const now = Date.now();
  const open = cfg.faOpensAt ? Date.parse(cfg.faOpensAt) : null;
  const close = cfg.faClosesAt ? Date.parse(cfg.faClosesAt) : null;
  if (open && Number.isFinite(open) && now < open) {
    return `Free agency has not opened yet (opens ${cfg.faOpensAt}).`;
  }
  if (close && Number.isFinite(close) && now > close) {
    return `Free agency is closed (deadline was ${cfg.faClosesAt}).`;
  }
  return null;
}

module.exports = { faWindowError };
