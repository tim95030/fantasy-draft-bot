const fs = require('fs');
const path = require('path');
const paths = require('../paths');

const DEFAULTS = { enabled: true, intervalMinutes: 60, inactiveDays: 7 };
function file(name) { return path.join(paths.DATA, `lineup-activity-${name}.json`); }
function read(name, fallback) {
  return fs.existsSync(file(name)) ? JSON.parse(fs.readFileSync(file(name), 'utf8')) : fallback;
}
function write(name, value) {
  fs.writeFileSync(`${file(name)}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file(name)}.tmp`, file(name));
}
function validate(settings) {
  if (typeof settings.enabled !== 'boolean' || !Number.isInteger(settings.intervalMinutes) ||
      settings.intervalMinutes < 15 || settings.intervalMinutes > 1440 || !Number.isInteger(settings.inactiveDays) ||
      settings.inactiveDays < 1 || settings.inactiveDays > 365) throw new Error('Invalid lineup activity settings');
  return settings;
}
function loadSettings() { return validate({ ...DEFAULTS, ...read('settings', {}) }); }
module.exports = { DEFAULTS, read, write, validate, loadSettings };
