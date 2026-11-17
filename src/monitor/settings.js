const fs = require('fs');
const path = require('path');
const paths = require('../paths');

const DEFAULTS = {
  enabled: false,
  intervalMinutes: 15,
  escalateAfterCycles: 4,
  seasonActive: true,
  rosterGraceHours: 72,
  commishUserIds: [],
  baselineUserIds: [],
};

function file(name) { return path.join(paths.DATA, `roster-monitor-${name}.json`); }

function read(name, fallback) {
  const target = file(name);
  return fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : fallback;
}

function write(name, data) {
  const target = file(name);
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${target}.tmp`, target);
}

function validateSettings(settings) {
  if (!Number.isInteger(settings.intervalMinutes) || settings.intervalMinutes < 5 || settings.intervalMinutes > 1440 ||
      !Number.isInteger(settings.escalateAfterCycles) || settings.escalateAfterCycles < 1 || settings.escalateAfterCycles > 96) {
    throw new Error('Invalid roster monitor timing settings.');
  }
  if (typeof settings.enabled !== 'boolean' || typeof settings.seasonActive !== 'boolean' ||
      !Number.isInteger(settings.rosterGraceHours) || settings.rosterGraceHours < 72) {
    throw new Error('Invalid roster monitor rule settings.');
  }
  if (!Array.isArray(settings.commishUserIds) || !Array.isArray(settings.baselineUserIds)) {
    throw new Error('Invalid roster monitor notification recipients.');
  }
  return settings;
}

function loadSettings() {
  return validateSettings({ ...DEFAULTS, ...read('settings', {}) });
}

function settingsHint(settings) {
  return `Checks every ${settings.intervalMinutes} minutes; escalation after ${settings.escalateAfterCycles} successful cycles ` +
    `(${settings.intervalMinutes * settings.escalateAfterCycles} minutes after owner notification; rule-specific grace periods apply).\n` +
    `Commish can adjust:\n\`/roster-monitor settings interval_minutes:${settings.intervalMinutes} escalate_after_cycles:${settings.escalateAfterCycles}\``;
}

module.exports = { DEFAULTS, read, write, loadSettings, validateSettings, settingsHint };
