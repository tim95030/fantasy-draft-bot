const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rosterIdFromInput } = require('./snapshot');
const { playerCandidates, retryPlayerMessage, linkedDropInputContext } = require('./playerInput');

const players = [
  { id: 'aho1', name: 'Sebastian Aho', position: 'C', team: 'CAR' },
  { id: 'aho2', name: 'Sebastian Aho', position: 'D', team: 'NYI' },
];
const roster = { items: players.map(({ id }) => ({ id })) };
const directory = new Map(players.map((p) => [p.id, p]));
const interaction = (commandName, values) => ({
  commandName,
  options: { data: Object.entries(values).map(([name, value]) => ({ name, value })) },
});

test('duplicate typed names offer both ID commands without silently picking one', () => {
  const ctx = interaction('drop-player', { player: 'Sebastian Aho', for_team: 'Calgary Flames', for_add: 'ahl:add1' });
  assert.throws(() => rosterIdFromInput(roster, directory, 'Sebastian Aho', { interaction: ctx }), (err) => {
    assert.match(err.message, /Sebastian Aho C, CAR/);
    assert.match(err.message, /Sebastian Aho D, NYI/);
    assert.match(err.message, /\/drop-player player:aho1 for_team:Calgary Flames for_add:ahl:add1/);
    assert.match(err.message, /\/drop-player player:aho2 for_team:Calgary Flames for_add:ahl:add1/);
    return true;
  });
  assert.equal(rosterIdFromInput(roster, directory, 'aho2', { interaction: ctx }), 'aho2');
});

test('typed position/team label narrows retry to the correct ID', () => {
  const ctx = interaction('minors-callup', { player: 'Sebastian Aho D, NYI', for_team: 'slot:3' });
  assert.throws(() => rosterIdFromInput(roster, directory, 'Sebastian Aho D, NYI', { interaction: ctx }), (err) => {
    assert.match(err.message, /\/minors-callup player:aho2 for_team:slot:3/);
    assert.doesNotMatch(err.message, /player:aho1/);
    return true;
  });
});

test('drop retry preserves the bid and only replaces the drop option', () => {
  const ctx = interaction('nhl-add', { player: 'add1', salary: '1.2m', drop: 'Sebastian Aho', for_team: 'slot:2' });
  const message = retryPlayerMessage(ctx, 'drop', playerCandidates(players, 'Sebastian Aho'));
  assert.match(message, /\/nhl-add player:add1 salary:1.2m drop:aho1 for_team:slot:2/);
  assert.match(message, /\/nhl-add player:add1 salary:1.2m drop:aho2 for_team:slot:2/);
});

test('unknown names offer a format without inventing a player ID', () => {
  const message = retryPlayerMessage(interaction('ahl-add', { player: 'Unknown' }), 'player', []);
  assert.match(message, /Check the name/);
  assert.match(message, /\/ahl-add player:<Fantrax ID>/);
  assert.doesNotMatch(message, /aho1|aho2/);
});

test('a bad optional drop retries only the drop, without repeating the accepted add or bid', () => {
  for (const kind of ['nhl', 'ahl']) {
    const values = { player: 'add1', salary: '1.2m', drop: 'Sebastian Aho', for_team: 'slot:2' };
    const ctx = linkedDropInputContext({ options: { getString: (key) => values[key] } }, kind, 'add1');
    const message = retryPlayerMessage(ctx.interaction, 'player', players);
    assert.match(message, new RegExp(`/drop-player player:aho1 for_team:slot:2 for_add:${kind}:add1`));
    assert.doesNotMatch(message, /salary:|\/nhl-add|\/ahl-add/);
  }
});
