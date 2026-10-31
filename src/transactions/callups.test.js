const { test } = require('node:test');
const assert = require('node:assert/strict');
const { callupError } = require('./callups');

test('minors contract can be called up', () => {
  assert.equal(callupError({ contract: 'Minors', status: 'MINORS' }, 'Quentin Musty'), null);
  assert.equal(callupError({ contract: 'Minors', status: 'ACTIVE' }, 'Quentin Musty'), null);
});

test('pro contracts cannot be called up again', () => {
  for (const contract of ['First', '1', '6']) {
    assert.match(callupError({ contract }, 'Stephen Halliday'), /already on a pro contract/);
  }
});

test('player missing from roster is rejected', () => {
  assert.match(callupError(undefined, 'Nobody'), /isn't on your Fantrax roster/);
});
