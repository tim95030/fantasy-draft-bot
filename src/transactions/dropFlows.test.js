const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('../paths');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-drop-flows-'));
paths.DATA = temp;
paths.CONFIG_JSON = path.join(temp, 'config.json');
paths.AUDIT_LOG = path.join(temp, 'audit.jsonl');
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const registry = require('./registry');
const snapshot = require('./snapshot');
const fantrax = require('../draft/fantrax');
const common = require('./common');
const threads = require('./threads');
const drops = require('./drops');
const auctions = require('./auctions');
const dropCommand = require('../commands/drop-player');
const ahlCommand = require('../commands/ahl-add');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function fixture(t) {
  registry.saveRegistry({});
  const player = { id: 'drop1', name: 'Roster Player', position: 'C', team: 'ANA' };
  const add = { id: 'add1', name: 'Add Player', position: 'D', team: 'CAR' };
  const directory = new Map([[player.id, player], [add.id, add]]);
  const team = { teamName: 'Example', items: [{ id: player.id, contract: '1', status: 'ACTIVE' }] };
  const ownership = { teams: new Map([['team', team]]), byPlayerId: new Map() };
  t.mock.method(common, 'txnConfig', () => ({ mode: 'live', dropsChannelId: 'drops', ahlAddsChannelId: 'ahl' }));
  t.mock.method(common, 'resolveTeam', () => ({ team, actingUserId: 'owner' }));
  t.mock.method(snapshot, 'getSnapshot', async () => ({ directory, ownership, minors: new Map([['add1', { round: '24' }]]) }));
  t.mock.method(fantrax, 'fetchRosterOwnership', async () => ownership);
  const messages = [];
  const makeThread = (id, parentId) => ({
    id, parentId, url: `https://discord.com/channels/guild/${id}`, archived: false, locked: false,
    send: async ({ content }) => { messages.push({ id, content }); return { id: 'msg' }; },
  });
  const addThread = makeThread('addthread', 'nhl');
  const dropThread = makeThread('dropthread', 'drops');
  const channels = new Map([[addThread.id, addThread], [dropThread.id, dropThread], ['drops', { id: 'drops' }], ['ahl', { id: 'ahl' }]]);
  const client = { channels: { cache: channels, fetch: async (id) => channels.get(id) } };
  const seedAuction = () => registry.upsertEntry('nhl', 'add1', {
    status: 'open', threadId: addThread.id, channelId: 'nhl', player: add,
    highBid: { userId: 'owner', teamName: 'Example', amount: 850000 }, closeAt: new Date(0).toISOString(),
  });
  const seedDrop = () => registry.upsertEntry('drop', 'drop1', {
    status: 'posted', threadId: dropThread.id, channelId: 'drops', player,
    createdAt: new Date().toISOString(), teamName: 'Example',
  });
  const replies = [];
  const interaction = (commandName, values) => ({
    commandName, client, guildId: 'guild', user: { id: 'owner', tag: 'owner' },
    options: { data: Object.entries(values).map(([name, value]) => ({ name, value })), getString: (name) => values[name] || null },
    deferReply: async () => {}, editReply: async (text) => replies.push(text),
  });
  return { player, add, team, messages, client, addThread, dropThread, seedAuction, seedDrop, interaction, replies };
}

test('a drop linked while roster lookup waits for close is filed immediately for the winner', async (t) => {
  const f = fixture(t);
  f.seedAuction(); f.seedDrop();
  const lookup = deferred(); const started = deferred();
  const original = snapshot.getSnapshot;
  t.mock.method(snapshot, 'getSnapshot', async () => { started.resolve(); await lookup.promise; return original(); });
  auctions.bindClient(f.client);
  const linking = dropCommand.execute(f.interaction('drop-player', { player: 'drop1', for_add: 'nhl:add1' }));
  await started.promise;
  await auctions.closeAuction('add1');
  lookup.resolve();
  await linking;
  assert.equal(registry.getEntry('nhl', 'add1').linkedDropThreadId, 'dropthread');
  assert.match(f.replies.at(-1), /Linked existing drop thread/);
  assert.ok(f.messages.some((m) => m.id === 'dropthread' && m.content.includes('Linked add:')));
  assert.ok(f.messages.some((m) => m.id === 'addthread' && m.content.includes('Linked drop:')));
});

test('close waits for the auction lock and consumes the most recently saved drop', async (t) => {
  const f = fixture(t); f.seedAuction(); f.seedDrop(); auctions.bindClient(f.client);
  const release = deferred(); const entered = deferred();
  const saving = threads.withLock(threads.registryKey('nhl', 'add1'), async () => {
    entered.resolve(); await release.promise;
    drops.saveAuctionDrop('add1', 'Example', { id: 'drop1', player: f.player, label: 'Roster Player' }, 'owner');
  });
  await entered.promise;
  const closing = auctions.closeAuction('add1');
  await new Promise(setImmediate);
  assert.equal(registry.getEntry('nhl', 'add1').status, 'open');
  release.resolve(); await saving; await closing;
  assert.equal(registry.getEntry('nhl', 'add1').linkedDropThreadId, 'dropthread');
  assert.deepEqual(registry.getEntry('nhl', 'add1').linkedDrops, {});
});

test('late drop links for a losing team are rejected instead of silently saved', async (t) => {
  const f = fixture(t); f.seedAuction();
  const lookup = deferred(); const started = deferred(); const original = snapshot.getSnapshot;
  t.mock.method(snapshot, 'getSnapshot', async () => { started.resolve(); await lookup.promise; return original(); });
  const linking = dropCommand.execute(f.interaction('drop-player', { player: 'drop1', for_add: 'nhl:add1' }));
  await started.promise;
  registry.upsertEntry('nhl', 'add1', { status: 'awaiting_years', winner: { teamName: 'Other' } });
  lookup.resolve(); await linking;
  assert.match(f.replies.at(-1), /no longer yours to link/);
  assert.equal(registry.getEntry('nhl', 'add1').linkedDrops, undefined);
  assert.equal(f.messages.length, 0);
});

test('AHL add reuses the existing drop and links both threads without recording another drop', async (t) => {
  const f = fixture(t); f.seedDrop();
  const ahlThread = { ...f.addThread, id: 'ahlthread', url: 'https://discord.com/channels/guild/ahlthread' };
  t.mock.method(threads, 'createThread', async () => ahlThread);
  await ahlCommand.execute(f.interaction('ahl-add', { player: 'add1', drop: 'drop1' }));
  assert.match(f.replies.at(-1), /Linked drop filed/);
  assert.ok(f.messages.some((m) => m.id === 'dropthread' && m.content.includes(ahlThread.url)));
  assert.ok(f.messages.some((m) => m.id === 'addthread' && m.content.includes(f.dropThread.url)));
  assert.deepEqual(registry.loadDrops(), []);
});

test('existing archived drop threads stay archived and are not falsely linked', async (t) => {
  const f = fixture(t); f.seedDrop(); f.dropThread.archived = true;
  const result = await drops.fileDrop({ client: f.client, teamName: 'Example', playerId: 'drop1', byUserId: 'owner', linkedAddUrl: f.addThread.url });
  assert.match(result.error, /archived/);
  assert.equal(f.messages.length, 0);
  assert.equal(f.dropThread.archived, true);
});

test('reusing the same drop/add link does not duplicate the reverse message', async (t) => {
  const f = fixture(t); f.seedDrop();
  const request = { client: f.client, teamName: 'Example', playerId: 'drop1', byUserId: 'owner', linkedAddUrl: f.addThread.url };
  await drops.fileDrop(request); await drops.fileDrop(request);
  assert.equal(f.messages.filter((m) => m.id === 'dropthread').length, 1);
});
