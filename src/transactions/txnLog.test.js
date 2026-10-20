const { test } = require('node:test');
const assert = require('node:assert/strict');
const { serializeErr, failureKindFromErr } = require('./txnLog');

test('serializeErr captures Discord REST fields', () => {
  const err = new Error('Missing Access');
  err.code = 50001;
  err.status = 403;
  err.rawError = { code: 50001, message: 'Missing Access' };
  const s = serializeErr(err);
  assert.equal(s.code, 50001);
  assert.equal(s.discordCode, 50001);
});

test('failureKindFromErr classifies missing access', () => {
  assert.equal(failureKindFromErr({ code: 50001 }), 'discord_missing_access');
  assert.equal(failureKindFromErr(new Error('bid too low')), 'validation');
});
