const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rosterLimits, countRoster, rosterFull, fullRosterNotice, spotsLine, splitRosterRows } = require('./roster');

const items = (spec) =>
  Object.entries(spec).flatMap(([status, n]) => Array.from({ length: n }, () => ({ status })));

test('counts by Fantrax slot: pro is Active + Reserve, IR and Minors excluded', () => {
  const counts = countRoster(items({ ACTIVE: 18, RESERVE: 5, INJURED_RESERVE: 2, MINORS: 30 }));
  assert.deepEqual(counts, { pro: 23, ir: 2, minors: 30 });
});

test('full roster check uses the group the add fills', () => {
  const limits = rosterLimits({});
  assert.deepEqual(limits, { pro: 23, minors: 30 });
  assert.equal(rosterFull('nhl', { pro: 23, minors: 10 }, limits), true);
  assert.equal(rosterFull('nhl', { pro: 22, minors: 30 }, limits), false);
  assert.equal(rosterFull('ahl', { pro: 23, minors: 30 }, limits), true);
  assert.equal(rosterFull('ahl', { pro: 23, minors: 29 }, limits), false);
});

test('limits come from config when set', () => {
  assert.deepEqual(rosterLimits({ proRosterMax: 24, minorsRosterMax: 28 }), { pro: 24, minors: 28 });
});

test('full roster notice shows the link command and the auction caveat', () => {
  const text = fullRosterNotice('nhl', { pro: 23, minors: 0 }, { pro: 23, minors: 30 }, 'James Reimer', { auction: true });
  assert.match(text, /pro roster is full \(23\/23\)/);
  assert.match(text, /for_add:James Reimer/);
  assert.match(text, /only filed if you win/);
  assert.doesNotMatch(fullRosterNotice('ahl', { pro: 0, minors: 30 }, { pro: 23, minors: 30 }, 'X'), /only filed if you win/);
});

test('spots line states open NHL and AHL spots plainly', () => {
  assert.equal(
    spotsLine({ pro: 22, minors: 30 }, { pro: 23, minors: 30 }),
    '**NHL Spots: 1 open (22/23)  ·  AHL Spots: 0 open (30/30)**',
  );
  assert.match(spotsLine({ pro: 25, minors: 31 }, { pro: 23, minors: 30 }), /NHL Spots: 0 open.*AHL Spots: 0 open/);
});

test('roster rows split into NHL and minors lists with IR and uncalled tags', () => {
  const { nhl, minors } = splitRosterRows([
    { name: 'A', item: { status: 'ACTIVE', contract: '3' } },
    { name: 'B', item: { status: 'INJURED_RESERVE', contract: '1' } },
    { name: 'C', item: { status: 'RESERVE', contract: 'Minors' } },
    { name: 'D', item: { status: 'MINORS', contract: 'Minors' } },
  ]);
  assert.deepEqual(nhl.map((r) => [r.name, r.tags]), [['A', []], ['B', ['IR']], ['C', ['uncalled minors']]]);
  assert.deepEqual(minors.map((r) => r.name), ['D']);
});
