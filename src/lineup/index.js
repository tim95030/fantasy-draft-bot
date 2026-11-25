const source = require('./source');
const store = require('./settings');
const { loadConfig } = require('../config');
const { getLeagueId } = require('../draft/fantrax');

function createTracker({ collect = source.collect, storage = store, getConfig = loadConfig,
  leagueId = getLeagueId, now = Date.now } = {}) {
  let inFlight = null;
  let timer = null;
  let started = false;
  function state() {
    const current = storage.read('state', null);
    if (current && (current.version !== 1 || current.leagueId !== leagueId() || !Array.isArray(current.teams))) {
      throw new Error('Lineup activity state is invalid or belongs to another league');
    }
    return current;
  }
  function scan() {
    if (inFlight) return inFlight;
    inFlight = run().finally(() => { inFlight = null; });
    return inFlight;
  }
  async function run() {
    const settings = storage.loadSettings();
    if (!settings.enabled) return { skipped: 'paused' };
    if (getConfig().transactions.mode !== 'live') return { skipped: 'practice_mode' };
    const previous = state();
    const at = now();
    try {
      const input = await collect();
      if (input.leagueId !== leagueId() || input.teams.length !== 32 ||
          new Set(input.teams.map((t) => t.teamId)).size !== 32) throw new Error('Incomplete lineup activity snapshot');
      const next = { version: 1, ...input, lastScanAt: at, lastAttemptAt: at, lastError: null };
      storage.write('state', next);
      console.info(`Lineup activity: checked ${next.teams.length} teams (commish reports only).`);
      return next;
    } catch (err) {
      storage.write('state', { ...(previous || { version: 1, leagueId: leagueId(), teams: [] }),
        lastAttemptAt: at, lastError: 'Fantrax history check failed; previous results retained.' });
      throw err;
    }
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    let minutes = 60;
    try { minutes = storage.loadSettings().intervalMinutes; } catch (err) { console.error('Lineup activity settings:', err.message); }
    timer = setTimeout(() => { tick().finally(schedule); }, minutes * 60_000);
    timer.unref?.();
  }
  async function tick() {
    try { await scan(); } catch (err) { console.error('Lineup activity check failed:', err.message); }
  }
  function start() {
    if (started) return;
    started = true;
    tick().finally(schedule);
  }
  function reschedule() { if (started) schedule(); }
  return { scan, state, start, reschedule };
}

const tracker = createTracker();
module.exports = { createTracker, tracker };
