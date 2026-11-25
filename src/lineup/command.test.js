const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('../paths');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lineup-command-'));
paths.DATA = dir;
paths.CONFIG_JSON = path.join(dir, 'config.json');
fs.writeFileSync(paths.CONFIG_JSON, JSON.stringify({ transactions: { commishUserIds: ['bren'] } }));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const command = require('../commands/lineup-activity');
const settings = require('./settings');
const event = require('../events/interactionCreate');

function caller(id) {
  return { user: { id }, member: { permissions: { has: () => true } },
    commandName: 'lineup-activity', channelId: 'other', isAutocomplete: () => false, isChatInputCommand: () => true,
    options: { getSubcommand: () => 'settings', getInteger: () => null, getBoolean: () => null },
    reply: async function (p) { this.response = p; } };
}

test('actual command auth uses configured commish IDs, rejects server admins, and is reachable outside draft channel', async () => {
  const commands = new Map([['lineup-activity', command]]);
  const owner = caller('owner'); await event.execute(owner, { commands });
  assert.equal(owner.response.ephemeral, true); assert.match(owner.response.content, /Only the configured league commish/);
  assert.equal(settings.read('settings', null), null);
  const bren = caller('bren'); await event.execute(bren, { commands });
  assert.equal(bren.response.ephemeral, true); assert.match(bren.response.content, /commish-only/);
  assert.deepEqual(settings.loadSettings(), settings.DEFAULTS);
  assert.ok(fs.existsSync(path.join(dir, 'lineup-activity-settings.json')));
  const blocked = { ...caller('bren'), commandName: 'draft-status' };
  await event.execute(blocked, { commands: new Map([['draft-status', { execute: () => { throw Error('Must stay blocked'); } }]]) });
  assert.match(blocked.response.content, /No draft channel set/);
});
