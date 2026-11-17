const fs = require('fs');
const fantrax = require('../draft/fantrax');
const paths = require('../paths');
const registry = require('../transactions/registry');
const { loadConfig } = require('../config');
const { loadOrder, ownerIds } = require('../draft/order');
const source = require('./source');
const { evaluate } = require('./rules');
const store = require('./settings');

function evidence() {
  // Unlike the transaction UI, enforcement must not interpret corrupt or missing evidence as an empty registry.
  if (!fs.existsSync(registry.REGISTRY) || !fs.existsSync(paths.AUDIT_LOG)) throw new Error('Transaction evidence files are missing');
  const records = Object.values(JSON.parse(fs.readFileSync(registry.REGISTRY, 'utf8')));
  const drops = fs.existsSync(registry.DROPS) ? JSON.parse(fs.readFileSync(registry.DROPS, 'utf8')) : [];
  if (!Array.isArray(drops)) throw new Error('Invalid drop history');
  if (fs.existsSync(paths.AUDIT_LOG)) {
    for (const line of fs.readFileSync(paths.AUDIT_LOG, 'utf8').split('\n').filter(Boolean)) {
      const row = JSON.parse(line);
      if (row.event === 'txn.callup') records.push({ ...row, kind: 'callup', playerId: fantrax.normalizeFantraxId(row.fantraxId) });
    }
  }
  return { records, drops };
}

function splitMessages(text) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > 1900) {
    let at = remaining.lastIndexOf('\n', 1900);
    if (at < 500) at = 1900;
    chunks.push(remaining.slice(0, at));
    remaining = remaining.slice(at).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function createMonitor({ collect = source.collect, getEvidence = evidence, getConfig = loadConfig,
  getOrder = loadOrder, now = Date.now, storage = store } = {}) {
  let running = false;
  let timer = null;
  let client = null;

  async function dm(id, text) {
    const user = await client.users.fetch(id);
    for (const content of splitMessages(text)) await user.send({ content, allowedMentions: { parse: [] } });
  }

  async function scan(c = client) {
    if (running) return { skipped: 'already_running' };
    client = c;
    running = true;
    try {
      const settings = storage.loadSettings();
      if (!settings.enabled) return { skipped: 'disabled' };
      if (!settings.commishUserIds.length || !settings.baselineUserIds.length) throw new Error('Monitor recipients are not configured');
      const config = getConfig();
      if (config.transactions.mode !== 'live') return { skipped: 'practice_mode' };
      const order = getOrder();
      const input = await collect();
      if (!input.leagueId || input.teams.length !== 32 || new Set(input.teams.map((t) => t.teamId)).size !== 32) {
        throw new Error('Incomplete league snapshot');
      }
      let state = storage.read('state', null);
      if (state && (state.version !== 1 || state.leagueId !== input.leagueId || !state.snapshot || !state.incidents)) {
        throw new Error('Monitor state is invalid or belongs to another league');
      }
      const at = now();
      const result = evaluate({ ...input, previous: state?.snapshot, ...getEvidence(), settings,
        txnConfig: config.transactions, now: at });
      if (!state) {
        state = { version: 1, leagueId: input.leagueId, baselineAt: at, snapshot: result.snapshot,
          baselineConditions: result.conditions, baselineSent: {}, incidents: {}, scan: 0 };
        for (const condition of result.conditions) {
          state.incidents[condition.key] = { ...condition, baseline: true, firstSeenAt: at };
        }
      } else {
        state.scan++;
        const live = new Set(result.conditions.map((c) => c.key));
        for (const key of Object.keys(state.incidents)) {
          if (!live.has(key)) delete state.incidents[key];
        }
        for (const condition of result.conditions) {
          const existing = state.incidents[condition.key];
          state.incidents[condition.key] = existing ? { ...existing, ...condition } :
            { ...condition, firstSeenAt: at, ownerNotified: {}, cycles: 0, escalatedTo: {}, deliveryFailedTo: {} };
        }
        state.snapshot = result.snapshot;
      }
      state.lastScanAt = at;
      storage.write('state', state);

      for (const id of new Set(settings.baselineUserIds)) {
        if (state.baselineSent[id]) continue;
        const lines = state.baselineConditions.map((c) => `• ${c.teamName}: ${c.detail}\n  ${c.remedy}`);
        try {
          await dm(id, `**Roster monitor: initial report**\nExisting issues are baseline-only; no owners were warned. ` +
            `This is a roster consistency check, not proof of who made a change.\n\n${lines.join('\n\n') || 'No current issues detected.'}\n\n${store.settingsHint(settings)}`);
          state.baselineSent[id] = at;
          storage.write('state', state);
        } catch (err) { console.warn(`Roster monitor initial DM failed for ${id}: ${err.message}`); }
      }
      for (const issue of Object.values(state.incidents)) {
        if (issue.baseline) continue;
        const team = order.teams.find((t) => fantrax.normalizeTeamName(t.teamName) === fantrax.normalizeTeamName(issue.teamName));
        const owners = team ? ownerIds(team) : [];
        const alreadyWarned = Object.values(issue.ownerNotified).some((n) => n.scan < state.scan);
        if (alreadyWarned) issue.cycles++;
        const deadline = issue.firstSeenAt + issue.graceHours * 3_600_000;
        const grace = issue.graceHours ? `\nRoster-space grace deadline: ${new Date(deadline).toISOString()} (${issue.graceHours} hours from first observation).` : '';
        for (const id of owners) {
          if (issue.ownerNotified[id] || issue.deliveryFailedTo[id]) continue;
          try {
            await dm(id, `**Roster check — ${issue.teamName}**\n${issue.detail}\n\n${issue.remedy}${grace}\n\n` +
              `If still unresolved, the commish is notified after ${settings.escalateAfterCycles} successful check cycles ` +
              `(normally ${settings.intervalMinutes * settings.escalateAfterCycles} minutes), no earlier than any grace deadline.\n` +
              'This reports the roster condition; it does not establish who changed it.');
            issue.ownerNotified[id] = { at, scan: state.scan };
          } catch (err) { issue.deliveryFailedTo[id] = { at, error: String(err.message).slice(0, 200) }; }
          storage.write('state', state);
        }
        const deliveryProblem = !owners.length || Object.keys(issue.deliveryFailedTo).length > 0;
        const escalationDue = issue.cycles >= settings.escalateAfterCycles && at >= deadline;
        if (deliveryProblem || escalationDue) {
          for (const id of new Set(settings.commishUserIds)) {
            const reason = escalationDue ? 'unresolved' : 'delivery';
            const key = `${id}:${reason}`;
            if (issue.escalatedTo[key]) continue;
            try {
              await dm(id, `**Roster monitor — ${escalationDue ? 'unresolved issue' : 'owner notification unavailable'}**\n` +
                `${issue.teamName}${owners.length ? ` (owners: ${owners.map((o) => `<@${o}>`).join(', ')})` : ' (no mapped Discord owner)'}\n` +
                `${issue.detail}\n${issue.remedy}\nFirst observed: ${new Date(issue.firstSeenAt).toISOString()}. ` +
                `Successful cycles after warning: ${issue.cycles}.${grace}\n` +
                (deliveryProblem ? 'One or more owners could not be notified; contact them directly.\n' : '') +
                `\n${store.settingsHint(settings)}`);
              issue.escalatedTo[key] = at;
              storage.write('state', state);
            } catch (err) { console.warn(`Roster monitor commish DM failed for ${id}: ${err.message}`); }
          }
        }
      }
      storage.write('state', state);
      console.info(`Roster monitor: completed scan ${state.scan}; ${Object.keys(state.incidents).length} current conditions.`);
      return { issues: Object.keys(state.incidents).length, baselineAt: state.baselineAt, lastScanAt: at };
    } finally { running = false; }
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    let interval = 15;
    try { interval = storage.loadSettings().intervalMinutes; } catch (err) { console.error('Roster monitor settings:', err.message); }
    timer = setTimeout(async () => {
      try { await scan(); } catch (err) { console.error('Roster monitor scan failed (no cycle counted):', err.message); }
      schedule();
    }, interval * 60_000);
    timer.unref?.();
  }

  function start(c) {
    client = c;
    scan().catch((err) => console.error('Roster monitor scan failed (no cycle counted):', err.message)).finally(schedule);
  }
  function reschedule() { if (client) schedule(); }
  return { scan, start, reschedule };
}

const monitor = createMonitor();
module.exports = { createMonitor, monitor, evidence, splitMessages };
