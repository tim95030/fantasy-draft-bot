const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTracker } = require('./index');
const { report } = require('./report');
const { DEFAULTS } = require('./settings');
const { createExecute } = require('../commands/lineup-activity');
const DAY = 86_400_000;
const start = Date.parse('2026-11-25T12:00:00Z');
const teams = () => Array.from({ length: 32 }, (_, i) => ({ teamId: String(i), teamName: `Team ${i}`,
  lastChange: { at: start - i * DAY, transactionId: `tx${i}`, periods: [51, 55] } }));
function harness(collector) {
  const data = {}; let time = start, fail = false, calls = 0;
  const storage = { loadSettings: () => ({ ...DEFAULTS, ...data.settings }),
    read: (name, fallback) => structuredClone(data[name] ?? fallback),
    write: (name, value) => { data[name] = structuredClone(value); } };
  const create = () => createTracker({ storage, leagueId: () => 'league', now: () => time,
    getConfig: () => ({ transactions: { mode: 'live' } }), collect: async () => {
      calls++; if (fail) throw Error('unavailable');
      return collector ? collector() : { leagueId: 'league', teams: teams() };
    } });
  return { data, storage, tracker: create(), create, fail: () => { fail = true; }, calls: () => calls,
    step: () => { time += DAY; } };
}
function interaction(id, subcommand = 'report', options = {}) {
  return { user: { id }, member: { permissions: { has: () => true } },
    options: { getSubcommand: () => subcommand, getInteger: n => options[n] ?? null, getBoolean: n => options[n] ?? null },
    reply: async function (p) { this.response = p; },
    deferReply: async function (p) { this.deferred = p; }, editReply: async function (p) { this.response = p; } };
}

test('failed and incomplete scans preserve last successful data and report unavailable instead of inactivity', async () => {
  const h = harness(); await h.tracker.scan(); const before = h.tracker.state(); h.step(); h.fail();
  await assert.rejects(h.tracker.scan());
  const after = h.tracker.state(); assert.deepEqual(after.teams, before.teams); assert.equal(after.lastScanAt, before.lastScanAt);
  const p = report(after, DEFAULTS, 7, start + DAY);
  assert.match(p.content, /unavailable\/stale/); assert.ok(!JSON.stringify(p.embeds).includes('— review'));
  const incomplete = harness(() => ({ leagueId: 'league', teams: [] }));
  await assert.rejects(incomplete.tracker.scan(), /Incomplete/); assert.equal(incomplete.tracker.state().lastScanAt, undefined);
});

test('overlapping scans share a single collection and restarts retain the last snapshot', async () => {
  let release; const pending = new Promise(r => { release = r; }); const h = harness(() => pending);
  const first = h.tracker.scan(), second = h.tracker.scan(); assert.strictEqual(first, second); assert.equal(h.calls(), 1);
  release({ leagueId: 'league', teams: teams() }); await first;
  assert.deepEqual(h.create().state(), h.tracker.state());
});

test('paused and practice-mode collection does not contact Fantrax', async () => {
  const h = harness(); h.data.settings = { enabled: false };
  assert.deepEqual(await h.tracker.scan(), { skipped: 'paused' }); assert.equal(h.calls(), 0);
  const tracker = createTracker({ storage: h.storage, getConfig: () => ({ transactions: { mode: 'practice' } }),
    collect: () => { throw Error('Must not collect'); } });
  h.data.settings.enabled = true;
  assert.deepEqual(await tracker.scan(), { skipped: 'practice_mode' });
});

test('report orders oldest first, uses the selected threshold, includes all teams and fits Discord limits', () => {
  const state = { leagueId: 'league', lastScanAt: start, teams: teams() };
  const p = report(state, DEFAULTS, 7, start);
  assert.match(p.content, /25\/32 teams/); assert.match(p.embeds[0].description, /^\*\*Team 31\*\*/);
  assert.match(p.embeds[1].description, /\*\*Team 0\*\*/); assert.match(p.embeds[0].description, /periods 51, 55/);
  assert.ok(p.content.length < 2000); assert.ok(p.embeds.every(e => e.description.length < 4096));
  assert.ok(p.embeds.reduce((n,e) => n + e.title.length + e.description.length, 0) < 6000);
  state.teams[0].lastChange = null;
  assert.match(JSON.stringify(report(state, DEFAULTS, 7, start)), /no recorded change/);
  assert.match(report(state, DEFAULTS, 7, start + DAY).content, /unavailable\/stale/);
  assert.match(report(state, { ...DEFAULTS, enabled: false }, 7, start).content, /checks paused/);
});

test('every subcommand rejects non-commish before reading data or collecting, even with Manage Server', async () => {
  const execute = createExecute({ isCommish: id => id === 'commish', storage: {
    loadSettings: () => { throw Error('Unauthorized read'); } } });
  for (const sub of ['report', 'settings']) {
    const caller = interaction('owner', sub); await execute(caller);
    assert.equal(caller.response.ephemeral, true); assert.match(caller.response.content, /Only the configured league commish/);
  }
});

test('commish report defers privately, refreshes missing data, and report threshold does not mutate settings', async () => {
  const h = harness(); const execute = createExecute({ isCommish: () => true, storage: h.storage, activity: h.tracker, now: () => start });
  const caller = interaction('commish', 'report', { inactive_days: 14 }); await execute(caller);
  assert.equal(caller.deferred.ephemeral, true); assert.equal(h.calls(), 1);
  assert.match(caller.response.content, /threshold: 14 days/); assert.equal(h.data.settings, undefined);
  await execute(interaction('commish')); assert.equal(h.calls(), 1);
});

test('commish settings persist; invalid input cannot mutate settings', async () => {
  const h = harness(); const execute = createExecute({ isCommish: () => true, storage: h.storage, activity: h.tracker });
  const caller = interaction('commish', 'settings', { interval_minutes: 120, inactive_days: 10, enabled: false });
  await execute(caller); assert.deepEqual(h.data.settings, { ...DEFAULTS, intervalMinutes: 120, inactiveDays: 10, enabled: false });
  assert.equal(caller.response.ephemeral, true); const before = structuredClone(h.data.settings);
  await assert.rejects(execute(interaction('commish', 'settings', { interval_minutes: 0 })));
  assert.deepEqual(h.data.settings, before);
});
