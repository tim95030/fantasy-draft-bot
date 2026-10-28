const { test } = require('node:test');
const assert = require('node:assert/strict');
const { staleEntryReason, retireOnDrop, retireOnThreadDelete } = require('./lifecycle');

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

test('deleting a thread cancels open auctions but keeps decided winners', () => {
  assert.equal(retireOnThreadDelete({ kind: 'nhl', status: 'open' }), true);
  assert.equal(retireOnThreadDelete({ kind: 'nhl', status: 'won' }), false);
  assert.equal(retireOnThreadDelete({ kind: 'nhl', status: 'awaiting_years' }), false);
  assert.equal(retireOnThreadDelete({ kind: 'drop', status: 'posted' }), true);
});
