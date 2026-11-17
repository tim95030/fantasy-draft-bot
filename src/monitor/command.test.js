const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('../paths');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-monitor-command-'));
paths.DATA = dir;
paths.CONFIG_JSON = path.join(dir, 'config.json');
fs.writeFileSync(paths.CONFIG_JSON, JSON.stringify({ transactions: { commishUserIds: ['commish'] } }));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const command = require('../commands/roster-monitor');
const settings = require('./settings');

function interaction(userId, options = {}) {
  return { user: { id: userId }, member: { permissions: { has: () => true } },
    options: { getSubcommand: () => 'settings', getInteger: (name) => options[name] ?? null, getBoolean: (name) => options[name] ?? null },
    reply: async function (value) { this.response = value; } };
}

test('only configured commish can change settings, even if caller has Manage Server', async () => {
  const caller = interaction('owner', { interval_minutes: 5 });
  await command.execute(caller);
  assert.match(caller.response.content, /Only the configured league commish/);
  assert.equal(settings.read('settings', null), null);
});

test('commish timing settings persist without overwriting unrelated settings', async () => {
  settings.write('settings', { ...settings.DEFAULTS, commishUserIds: ['commish'], baselineUserIds: ['commish', 'tim'] });
  const caller = interaction('commish', { interval_minutes: 5, escalate_after_cycles: 8 });
  await command.execute(caller);
  const current = settings.loadSettings();
  assert.equal(current.intervalMinutes, 5);
  assert.equal(current.escalateAfterCycles, 8);
  assert.deepEqual(current.baselineUserIds, ['commish', 'tim']);
  assert.equal(caller.response.ephemeral, true);
  assert.match(caller.response.content, /interval_minutes:5 escalate_after_cycles:8/);
});

test('invalid timing is rejected before writing settings', async () => {
  const before = settings.read('settings', null);
  await assert.rejects(command.execute(interaction('commish', { interval_minutes: 0 })), /Invalid/);
  assert.deepEqual(settings.read('settings', null), before);
});

test('new command bypasses draft-channel gate without changing gates on existing draft commands', async () => {
  const event = require('../events/interactionCreate');
  const caller = { ...interaction('commish'), commandName: 'roster-monitor', isAutocomplete: () => false,
    isChatInputCommand: () => true, channelId: 'other' };
  await event.execute(caller, { commands: new Map([['roster-monitor', command]]) });
  assert.match(caller.response.content, /Roster monitor/);
  const blocked = { ...caller, commandName: 'draft-status' };
  await event.execute(blocked, { commands: new Map([['draft-status', { execute: async () => { throw new Error('Must not run'); } }]]) });
  assert.match(blocked.response.content, /No draft channel set/);
});
