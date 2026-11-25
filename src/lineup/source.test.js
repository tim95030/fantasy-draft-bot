const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDate, parseHistory, collect } = require('./source');

const now = Date.parse('2026-11-25T12:00:00Z');
const team = { id: 'team1', name: 'Team One' };
function fixture(id = team.id) {
  return { displayedSelections: { team: id, view: 'LINEUP_CHANGE', includeDeleted: false, executedOnly: true },
    paginatedResultSet: { pageNumber: 1, maxResultsPerPage: 20, totalNumResults: 1 },
    table: { header: { cells: [{ key: 'date', name: 'Date Processed (EST)' }] }, rows: [
      { txSetId: 'tx1', executed: true, deleted: false, cells: [
        { key: 'team', teamId: id }, { key: 'date', content: 'Tue Nov 24, 2026, 8:32PM' },
        { key: 'weekOrPeriod', content: '55', icon: 'CLOCK' },
      ] },
      { txSetId: 'tx1', executed: true, deleted: false, cells: [{ key: 'team', teamId: id }, { key: 'weekOrPeriod', content: '56' }] },
    ] } };
}

test('timestamps honor explicit fixed zone independent of host timezone and reject invalid dates', () => {
  assert.equal(parseDate('Tue Nov 24, 2026, 8:32PM', 'EST'), Date.parse('2026-11-25T01:32:00Z'));
  assert.equal(parseDate('Fri Sep 25, 2026, 5:00PM', 'EST'), Date.parse('2026-09-25T22:00:00Z'));
  assert.equal(parseDate('Fri Sep 25, 2026, 5:00PM', 'EDT'), Date.parse('2026-09-25T21:00:00Z'));
  assert.equal(parseDate('Tue Nov 24, 2026, 12:00AM', 'UTC'), Date.parse('2026-11-24T00:00:00Z'));
  for (const [text, zone] of [['Tue Feb 31, 2026, 8:32PM','EST'], ['Tue Nov 24, 2026, 13:32PM','EST'],
    ['Tue Nov 24, 2026, 8:62PM','EST'], ['Wed Nov 24, 2026, 8:32PM','EST'], ['Tue Nov 24, 2026, 8:32PM','XYZ']]) {
    assert.throws(() => parseDate(text, zone));
  }
});

test('grouped player rows share one activity timestamp and future periods do not change it', () => {
  const result = parseHistory(fixture(), team, now);
  assert.deepEqual(result, { teamId: team.id, teamName: team.name, lastChange: {
    transactionId: 'tx1', at: Date.parse('2026-11-25T01:32:00Z'), periods: [55, 56],
  } });
});

test('partial, wrongly filtered, deleted, unexecuted and future-dated histories fail closed', () => {
  const edits = [
    (d) => { d.table.rows = []; }, (d) => { d.table.rows[0].cells[0].teamId = 'other'; },
    (d) => { d.table.rows[0].deleted = true; }, (d) => { d.table.rows[0].executed = false; },
    (d) => { d.displayedSelections.executedOnly = false; }, (d) => { d.displayedSelections.includeDeleted = true; },
    (d) => { d.table.rows[0].cells = d.table.rows[0].cells.filter(c => c.key !== 'date'); },
    (d) => { d.paginatedResultSet.totalNumResults = 2; },
  ];
  for (const edit of edits) { const d = fixture(); edit(d); assert.throws(() => parseHistory(d, team, now)); }
  assert.throws(() => parseHistory(fixture(), team, now - 86_400_000), /future/);
});

test('empty history is explicitly unknown rather than an invented inactivity date', () => {
  const d = fixture(); d.table.rows = []; d.paginatedResultSet.totalNumResults = 0;
  assert.equal(parseHistory(d, team, now).lastChange, null);
});

test('collector reads all 32 teams with bounded concurrency and the read-only history method', async () => {
  const teams = Array.from({ length: 32 }, (_, i) => ({ id: `team${i}`, name: `Team ${i}` }));
  let active = 0, max = 0, calls = 0;
  const fetcher = async (url, options) => {
    if (!options.method) return { ok: true, json: async () => ({ teamInfo: teams }) };
    calls++; active++; max = Math.max(active, max);
    const msg = JSON.parse(options.body).msgs[0];
    assert.equal(msg.method, 'getTransactionDetailsHistory'); assert.equal(msg.data.view, 'LINEUP_CHANGE');
    assert.equal(msg.data.executedOnly, true); assert.equal(msg.data.includeDeleted, false);
    assert.equal(msg.data.pageNumber, 1); assert.ok(options.signal);
    await new Promise(resolve => setImmediate(resolve)); active--;
    return { ok: true, json: async () => ({ responses: [{ data: fixture(msg.data.team) }] }) };
  };
  const result = await collect({ leagueId: 'league', fetcher, now });
  assert.equal(result.teams.length, 32); assert.equal(calls, 32); assert.equal(max, 4);
});

test('HTTP-200 API errors and incomplete league lists are not accepted as empty histories', async () => {
  for (const body of [{ pageError: { text: 'denied' } }, { teamInfo: [] }]) {
    await assert.rejects(collect({ leagueId: 'league', fetcher: async () => ({ ok: true, json: async () => body }) }));
  }
});

module.exports = { fixture };

test('history must remain newest-first before trusting its first page as latest activity', () => {
  const d = fixture(); d.paginatedResultSet.totalNumResults = 2;
  const next = structuredClone(d.table.rows[0]); next.txSetId = 'newer';
  next.cells.find(c => c.key === 'date').content = 'Wed Nov 25, 2026, 1:00AM';
  d.table.rows.push(next);
  assert.throws(() => parseHistory(d, team, now), /not newest first/);
});

test('one failed team read fails the collection instead of returning a partial league', async () => {
  const teams = Array.from({ length: 32 }, (_, i) => ({ id: `team${i}`, name: `Team ${i}` }));
  await assert.rejects(collect({ leagueId: 'league', now, fetcher: async (url, options) => {
    if (!options.method) return { ok: true, json: async () => ({ teamInfo: teams }) };
    const teamId = JSON.parse(options.body).msgs[0].data.team;
    return { ok: true, json: async () => ({ responses: [teamId === 'team2' ? { pageError: { code: 'WARNING' } } : { data: fixture(teamId) }] }) };
  } }), /unavailable/);
});
