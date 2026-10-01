const fs = require('fs');
const paths = require('./paths');

const DEFAULTS = {
  adminUserIds: [],
  guildId: '',
  draftChannelId: '',
  startRound: 32,
  totalRounds: 10,
  secondsPerPick: 120,
  snake: true,
  allowDuplicateOwners: false,
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
  return { ...DEFAULTS, ...raw, adminUserIds: [...(raw.adminUserIds || [])] };
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
};
