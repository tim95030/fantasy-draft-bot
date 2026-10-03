const fs = require('fs');
const paths = require('./paths');

const DEFAULTS = {
  adminUserIds: [],
  guildId: '',
  draftChannelId: '',
  startRound: 32,
  totalRounds: 10,
  secondsPerPick: 120,
  /** Seconds remaining when to re-announce who's up (each must be < secondsPerPick). */
  pickWarningsSec: [],
  snake: true,
  allowDuplicateOwners: false,
  allowEditPicks: true,
  sleepEnabled: false,
  sleepStart: '22:00',
  sleepEnd: '08:00',
  sleepTimezone: 'America/Los_Angeles',
  /** 1 open skip → 1/4 clock; 2+ open skips → skip immediately. Autodraft still goes first. */
  skipAccelEnabled: true,
};

function ensureConfigFile() {
  if (!fs.existsSync(paths.CONFIG_JSON)) {
    const sample = fs.existsSync(paths.CONFIG_SAMPLE)
      ? JSON.parse(fs.readFileSync(paths.CONFIG_SAMPLE, 'utf8'))
      : DEFAULTS;
    fs.writeFileSync(paths.CONFIG_JSON, JSON.stringify({ ...DEFAULTS, ...sample }, null, 2));
  }
}

function loadConfig() {
  ensureConfigFile();
  const raw = JSON.parse(fs.readFileSync(paths.CONFIG_JSON, 'utf8'));
  const merged = { ...DEFAULTS, ...raw, adminUserIds: [...(raw.adminUserIds || [])] };
  merged.skipAccelEnabled = merged.skipAccelEnabled !== false;
  merged.pickWarningsSec = normalizePickWarnings(
    merged.pickWarningsSec,
    merged.secondsPerPick,
  );
  return merged;
}

/**
 * Keep unique positive int warning thresholds strictly below the pick clock.
 * Sorted descending (60, 30, 10) for display.
 */
function normalizePickWarnings(raw, secondsPerPick) {
  const limit = Math.max(1, Number(secondsPerPick) || 1);
  const set = new Set();
  for (const v of Array.isArray(raw) ? raw : []) {
    const n = Math.floor(Number(v));
    if (!Number.isInteger(n) || n < 1 || n >= limit) continue;
    set.add(n);
  }
  return [...set].sort((a, b) => b - a);
}

function saveConfig(config) {
  fs.writeFileSync(paths.CONFIG_JSON, JSON.stringify(config, null, 2));
  return config;
}

function updateConfig(partial) {
  const next = { ...loadConfig(), ...partial };
  return saveConfig(next);
}

function isAdmin(userId, member = null) {
  const config = loadConfig();
  if (config.adminUserIds.map(String).includes(String(userId))) return true;
  if (member?.permissions?.has?.('ManageGuild')) return true;
  return false;
}

module.exports = {
  DEFAULTS,
  loadConfig,
  saveConfig,
  updateConfig,
  isAdmin,
  ensureConfigFile,
  normalizePickWarnings,
};
