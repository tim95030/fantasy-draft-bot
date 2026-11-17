const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('./rules');
const { parseTeam } = require('./source');
const { createMonitor, splitMessages } = require('./index');
const { DEFAULTS, settingsHint } = require('./settings');

const HOUR = 3_600_000;
const start = Date.parse('2026-11-16T12:00:00Z');
const settings = { ...DEFAULTS, enabled: true, commishUserIds: ['commish'], baselineUserIds: ['commish', 'tim'] };
const item = (patch = {}) => ({ id: 'player1', name: 'Player One', status: 'MINORS', contract: 'Minors', minorsEligible: true, ...patch });
const team = (items = [], cap = {}) => ({ teamId: '1', teamName: 'Team One', items,
  cap: { used: 10_000_000, cap: 100_000_000, ...cap } });
function check(teams, previous = {}, extra = {}) {
  return evaluate({ teams, previous, records: [], drops: [], settings, txnConfig: {}, now: start, ...extra });
}

test('midseason eligibility crossing does not flag a held prospect, but an ineligible new acquisition does', () => {
  const previous = check([team([item()])]).snapshot;
  assert.equal(check([team([item({ minorsEligible: false })])], previous).conditions.length, 0);
  const empty = check([team()]).snapshot;
  assert.equal(check([team([item({ minorsEligible: false })])], empty).conditions[0].type, 'ineligible_minor_add');
});

test('unreported promotion stays unreported after a pro contract is assigned and cannot be undone by demotion', () => {
  const previous = check([team([item()])]).snapshot;
  const moved = check([team([item({ status: 'ACTIVE' })])], previous);
  assert.equal(moved.conditions[0].type, 'missing_callup');
  const contracted = check([team([item({ status: 'ACTIVE', contract: 'First' })])], moved.snapshot);
  assert.equal(contracted.conditions[0].type, 'missing_callup');
  assert.equal(check([team([item()])], moved.snapshot).conditions[0].type, 'illegal_senddown');
});

test('a bot callup receipt must match the team and occur after its last drop', () => {
  const teams = [team([item({ status: 'ACTIVE' })])];
  const receipt = { kind: 'callup', playerId: 'player1', teamName: 'Team One', threadId: 'thread', createdAt: new Date(start - HOUR).toISOString() };
  assert.equal(check(teams, {}, { records: [receipt] }).conditions.length, 0);
  assert.equal(check(teams, {}, { records: [{ ...receipt, teamName: 'Other' }] }).conditions.length, 1);
  assert.equal(check(teams, {}, { records: [receipt], drops: [{ playerId: 'player1', teamName: 'Team One', at: new Date(start).toISOString() }] }).conditions.length, 1);
});

test('minors in IR alone are not treated as scoring-lineup callups; offseason callup checks can be paused', () => {
  assert.equal(check([team([item({ status: 'INJURED_RESERVE' })])]).conditions.length, 0);
  assert.equal(check([team([item({ status: 'RESERVE' })])], {}, { settings: { ...settings, seasonActive: false } }).conditions.length, 0);
});

test('drop reacquisition violations persist past the cooldown rather than becoming legal merely with time', () => {
  const empty = check([team()]).snapshot;
  const drops = [{ teamName: 'Team One', playerId: 'player1', at: new Date(start - HOUR).toISOString() }];
  const reacquired = check([team([item()])], empty, { drops });
  assert.equal(reacquired.conditions[0].type, 'drop_cooldown');
  const later = check([team([item()])], reacquired.snapshot, { drops, now: start + 72 * HOUR });
  assert.equal(later.conditions[0].type, 'drop_cooldown');
});

test('a new minors acquisition held on reserve gets the constitutional 72-hour space window', () => {
  const full = Array.from({ length: 30 }, (_, n) => item({ id: `minor${n}` }));
  const before = check([team(full)]).snapshot;
  const added = check([team([...full, item({ status: 'RESERVE' })])], before);
  assert.equal(added.conditions.length, 0);
  const corrected = check([team([...full.slice(1), item()])], added.snapshot, { now: start + HOUR });
  assert.equal(corrected.conditions.length, 0);
  const overdue = check([team([...full, item({ status: 'RESERVE' })])], added.snapshot, { now: start + 72 * HOUR });
  assert.equal(overdue.conditions[0].type, 'missing_callup');
  const active = check([team([...full, item({ status: 'ACTIVE' })])], added.snapshot, { now: start + HOUR });
  assert.equal(active.conditions[0].type, 'missing_callup');
});

test('roster limits respect IR and filed drops, and cap uses adjusted Fantrax totals', () => {
  const items = Array.from({ length: 24 }, (_, n) => item({ id: String(n), status: 'ACTIVE', contract: '1' }));
  let result = check([team(items, { used: 100_100_000, cap: 100_475_000 })]);
  assert.deepEqual(result.conditions.map((c) => c.type), ['pro_limit']);
  assert.equal(result.conditions[0].graceHours, 72);
  result = check([team(items)], {}, { drops: [{ teamName: 'Team One', playerId: '0', at: new Date(start).toISOString() }] });
  assert.equal(result.conditions.length, 0);
  assert.equal(check([team([], { used: 101_000_000 })]).conditions[0].type, 'cap_limit');
});

function harness() {
  let time = start;
  let teams = Array.from({ length: 32 }, (_, n) => ({ ...team(), teamId: String(n + 1), teamName: `Team ${n + 1}` }));
  teams[0].teamName = 'Team One';
  const data = {};
  let options = structuredClone(settings);
  const messages = [];
  const blocked = new Set();
  let failure = false;
  const storage = {
    read: (key, fallback) => structuredClone(data[key] ?? fallback),
    write: (key, value) => { data[key] = structuredClone(value); },
    loadSettings: () => structuredClone(options),
  };
  const client = { users: { fetch: async (id) => ({ send: async ({ content }) => {
    if (blocked.has(id)) throw new Error('DM blocked');
    messages.push({ id, content });
  } }) } };
  const dependencies = { storage, now: () => time, collect: async () => {
    if (failure) throw new Error('Fantrax unavailable');
    return { leagueId: 'league', teams: structuredClone(teams) };
  }, getEvidence: () => ({ records: [], drops: [] }), getConfig: () => ({ transactions: { mode: 'live' } }),
  getOrder: () => ({ teams: [{ teamName: 'Team One', owners: [{ discordUserId: 'owner' }] }] }) };
  let monitor = createMonitor(dependencies);
  return { messages, data, blocked, scan: () => monitor.scan(client),
    step: (minutes = 15) => { time += minutes * 60_000; },
    change: (value) => { teams[0] = { ...teams[0], ...value }; },
    fail: (value) => { failure = value; },
    settings: (value) => { options = { ...options, ...value }; },
    restart: () => { monitor = createMonitor(dependencies); },
  };
}

test('initial conditions go only to Brenden and Tim and stay baseline-only until fixed', async () => {
  const h = harness(); h.change({ items: [item({ contract: 'First' })] });
  await h.scan();
  assert.deepEqual(h.messages.map((m) => m.id), ['commish', 'tim']);
  h.restart();
  for (let n = 0; n < 6; n++) { h.step(); await h.scan(); }
  assert.equal(h.messages.length, 2);
  h.change({ items: [] }); h.step(); await h.scan();
  h.change({ items: [item({ contract: 'First' })] }); h.step(); await h.scan();
  assert.equal(h.messages.at(-1).id, 'owner');
});

test('exactly four successful cycles after warning escalate once, with copyable settings', async () => {
  const h = harness(); await h.scan(); h.messages.length = 0;
  h.change({ items: [item({ contract: 'First' })] }); h.step(); await h.scan();
  assert.equal(h.messages.length, 1); assert.equal(h.messages[0].id, 'owner');
  for (let n = 0; n < 3; n++) { h.step(); await h.scan(); }
  assert.equal(h.messages.length, 1);
  h.step(); await h.scan();
  assert.equal(h.messages.length, 2); assert.equal(h.messages[1].id, 'commish');
  assert.match(h.messages[1].content, /\/roster-monitor settings interval_minutes:15 escalate_after_cycles:4/);
  h.restart(); h.step(); await h.scan(); assert.equal(h.messages.length, 2);
});

test('failed scans do not resolve issues or advance cycles; a fix prevents escalation', async () => {
  const h = harness(); await h.scan(); h.change({ items: [item({ contract: 'First' })] }); h.step(); await h.scan();
  const before = structuredClone(h.data.state);
  h.fail(true); h.step(); await assert.rejects(h.scan(), /unavailable/);
  assert.deepEqual(h.data.state, before);
  h.fail(false); h.change({ items: [] }); h.step(); await h.scan();
  assert.deepEqual(h.data.state.incidents, {});
  assert.equal(h.messages.filter((m) => m.content.includes('unresolved issue')).length, 0);
});

test('72-hour roster grace is not shortened by four fast cycles', async () => {
  const h = harness(); await h.scan();
  h.change({ items: Array.from({ length: 31 }, (_, n) => item({ id: String(n) })) });
  h.step(); await h.scan();
  for (let n = 0; n < 5; n++) { h.step(); await h.scan(); }
  assert.equal(h.messages.filter((m) => m.content.includes('unresolved issue')).length, 0);
  h.step(72 * 60); await h.scan();
  assert.equal(h.messages.filter((m) => m.content.includes('unresolved issue')).length, 1);
});

test('blocked owner DMs alert commish once instead of pretending an owner was warned', async () => {
  const h = harness(); await h.scan(); h.blocked.add('owner');
  h.change({ items: [item({ contract: 'First' })] }); h.step(); await h.scan();
  assert.match(h.messages.at(-1).content, /owner notification unavailable/);
  for (let n = 0; n < 5; n++) { h.step(); await h.scan(); }
  assert.equal(h.messages.filter((m) => m.content.includes('owner notification unavailable')).length, 1);
  assert.equal(Object.values(h.data.state.incidents)[0].cycles, 0);
});

test('timing changes apply to outstanding issues without resetting warnings', async () => {
  const h = harness(); await h.scan(); h.change({ items: [item({ contract: 'First' })] }); h.step(); await h.scan();
  h.step(); await h.scan(); h.settings({ escalateAfterCycles: 2, intervalMinutes: 5 }); h.step(5); await h.scan();
  assert.match(h.messages.at(-1).content, /interval_minutes:5 escalate_after_cycles:2/);
});

test('roster parser reads by header, rejects incomplete responses, and does not invent eligibility', () => {
  const data = { tables: [{ header: { cells: [{ key: 'contract' }] }, rows: [{ scorer: { scorerId: 'abc', name: 'A' }, statusId: '9', cells: [{ content: 'Minors' }] }] }],
    miscData: { salaryInfo: { info: [{ key: 'salaryUsed', value: 100 }, { key: 'salaryCap', value: 1000 }] } } };
  assert.equal(parseTeam(data, 'team', 'Team').items[0].minorsEligible, null);
  assert.throws(() => parseTeam({}, 'team', 'Team'), /tables/);
  assert.throws(() => parseTeam({ ...data, miscData: {} }, 'team', 'Team'), /cap/);
});

test('long reports split within Discord limits and commish settings hints include the effective frequency', () => {
  const text = 'one line\n'.repeat(1000);
  assert.ok(splitMessages(text).every((m) => m.length <= 1900));
  assert.match(settingsHint(settings), /60 minutes/);
});

test('paused monitor does not collect rosters or mutate existing incidents', async () => {
  const h = harness(); await h.scan();
  const before = structuredClone(h.data.state);
  h.settings({ enabled: false }); h.fail(true);
  assert.deepEqual(await h.scan(), { skipped: 'disabled' });
  assert.deepEqual(h.data.state, before);
});

test('overlapping scans are skipped and incomplete snapshots never establish a baseline', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const monitor = createMonitor({ storage: { loadSettings: () => settings },
    getConfig: () => ({ transactions: { mode: 'live' } }), getOrder: () => ({ teams: [] }),
    collect: () => pending });
  const first = monitor.scan({});
  assert.deepEqual(await monitor.scan({}), { skipped: 'already_running' });
  release({ leagueId: 'test', teams: [] });
  await assert.rejects(first, /Incomplete league snapshot/);
});
