const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  staleEntryReason,
  retireOnDrop,
  retireOnThreadDelete,
  winnerDropAction,
  addLinkOpen,
} = require('./lifecycle');
const { auctionDropFor } = require('./drops');

const HOUR = 60 * 60 * 1000;

test('closed NHL auction without a winner can be reopened', () => {
  assert.equal(staleEntryReason({ kind: 'nhl', status: 'closed' }), 'closed_without_winner');
});

test('live NHL auction states keep blocking new bids', () => {
  for (const status of ['open', 'awaiting_years', 'won']) {
    assert.equal(staleEntryReason({ kind: 'nhl', status }), null);
  }
});

test('drop thread blocks duplicates only within the cooldown', () => {
  const now = Date.parse('2026-10-28T00:00:00Z');
  const recent = { kind: 'drop', createdAt: new Date(now - 2 * HOUR).toISOString() };
  const old = { kind: 'drop', createdAt: new Date(now - 72 * HOUR).toISOString() };
  assert.equal(staleEntryReason(recent, { now, dropCooldownHours: 48 }), null);
  assert.equal(staleEntryReason(old, { now, dropCooldownHours: 48 }), 'previous_drop');
});

test('dropping a player clears finished auctions and AHL claims', () => {
  assert.equal(retireOnDrop({ kind: 'nhl', status: 'won' }), true);
  assert.equal(retireOnDrop({ kind: 'nhl', status: 'closed' }), true);
  assert.equal(retireOnDrop({ kind: 'nhl', status: 'awaiting_years' }), false);
  assert.equal(retireOnDrop({ kind: 'ahl', status: 'claimed' }), true);
  assert.equal(retireOnDrop(null), false);
});

test('auction winner drop: file saved drop, flag missing, ask when full, else nothing', () => {
  const limits = { pro: 23, minors: 30 };
  const roster = [{ id: 'abc' }, { id: 'def' }];
  assert.equal(winnerDropAction({ playerId: 'abc' }, roster, { pro: 23 }, limits), 'file');
  assert.equal(winnerDropAction({ playerId: 'zzz' }, roster, { pro: 23 }, limits), 'missing');
  assert.equal(winnerDropAction(null, roster, { pro: 23 }, limits), 'needs_drop');
  assert.equal(winnerDropAction(null, roster, { pro: 22 }, limits), 'none');
});

test('drops can be linked only while the add thread is still open', () => {
  const ahl = { kind: 'ahl' };
  const nhl = { kind: 'nhl' };
  assert.equal(addLinkOpen(ahl, { archived: false, locked: false }), true);
  assert.equal(addLinkOpen(ahl, { archived: false, locked: true }), false);
  assert.equal(addLinkOpen(nhl, { archived: false, locked: true }), true);
  assert.equal(addLinkOpen(nhl, { archived: true, locked: true }), false);
  assert.equal(addLinkOpen(ahl, undefined), false);
});

test('saved auction drops are looked up per winning team, ignoring case', () => {
  const entry = {
    linkedDrops: {
      [require('./drops').teamKey('Calgary Flames')]: { teamName: 'Calgary Flames', playerId: 'abc' },
    },
  };
  assert.equal(auctionDropFor(entry, 'calgary flames').playerId, 'abc');
  assert.equal(auctionDropFor(entry, 'Nashville Predators'), null);
  assert.equal(auctionDropFor(null, 'Calgary Flames'), null);
});

test('deleting a thread cancels open auctions but keeps decided winners', () => {
  assert.equal(retireOnThreadDelete({ kind: 'nhl', status: 'open' }), true);
  assert.equal(retireOnThreadDelete({ kind: 'nhl', status: 'won' }), false);
  assert.equal(retireOnThreadDelete({ kind: 'nhl', status: 'awaiting_years' }), false);
  assert.equal(retireOnThreadDelete({ kind: 'drop', status: 'posted' }), true);
});
