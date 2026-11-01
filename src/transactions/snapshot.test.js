const test = require('node:test');
const assert = require('node:assert/strict');
const { rosterIdFromInput } = require('./snapshot');

const fxTeam = { items: [{ id: 'aaa1' }, { id: 'bbb2' }, { id: 'ccc3' }] };
const directory = new Map([
  ['aaa1', { name: 'Devin Cooley' }],
  ['bbb2', { name: 'Adam Fox' }],
  ['ccc3', { name: 'Adam Foxworth' }],
]);

test('roster option accepts the autocomplete id or a typed name/label', () => {
  assert.equal(rosterIdFromInput(fxTeam, directory, 'aaa1'), 'aaa1');
  assert.equal(rosterIdFromInput(fxTeam, directory, '*aaa1*'.replace(/\*$/, '')), 'aaa1');
  assert.equal(rosterIdFromInput(fxTeam, directory, 'Devin Cooley G, CGY'), 'aaa1');
  assert.equal(rosterIdFromInput(fxTeam, directory, 'cooley'), 'aaa1');
  assert.equal(rosterIdFromInput(fxTeam, directory, 'Adam Fox'), 'bbb2');
  assert.equal(rosterIdFromInput(fxTeam, directory, 'adam fo'), 'adam fo');
});
