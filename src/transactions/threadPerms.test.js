const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits, OverwriteType } = require('discord.js');
const { COMMISH_THREAD_ALLOW, ensureCommishThreadAccess, upsertThreadOverwrite } = require('./threadPerms');
const { isTxnCommish, loadConfig, saveConfig } = require('../config');

function mockThread({ puts = [], memberAdds = [] } = {}) {
  return {
    id: 'thread1',
    guild: { id: 'g1', roles: { everyone: { id: 'everyone' } } },
    archived: false,
    setArchived: async () => {},
    members: {
      add: async (id) => {
        memberAdds.push(id);
      },
    },
    client: {
      rest: {
        put: async (route, { body }) => {
          puts.push({ route, body });
        },
        delete: async () => {},
      },
    },
  };
}

test('COMMISH_THREAD_ALLOW grants view, send in threads, and manage threads', () => {
  assert.ok(COMMISH_THREAD_ALLOW.includes(PermissionFlagsBits.ViewChannel));
  assert.ok(COMMISH_THREAD_ALLOW.includes(PermissionFlagsBits.SendMessagesInThreads));
  assert.ok(COMMISH_THREAD_ALLOW.includes(PermissionFlagsBits.ManageThreads));
});

test('ensureCommishThreadAccess adds members and REST overwrites', async () => {
  const puts = [];
  const memberAdds = [];
  const thread = mockThread({ puts, memberAdds });
  const ok = await ensureCommishThreadAccess(thread, ['111', '222']);
  assert.equal(ok, true);
  assert.deepEqual(memberAdds, ['111', '222']);
  const memberPuts = puts.filter((p) => p.body.type === OverwriteType.Member);
  assert.equal(memberPuts.length, 2);
  assert.equal(memberPuts[0].body.id, '111');
});

test('upsertThreadOverwrite uses channel permission REST route', async () => {
  const puts = [];
  const thread = mockThread({ puts });
  await upsertThreadOverwrite(thread, 'role1', OverwriteType.Role, {
    allow: [PermissionFlagsBits.ViewChannel],
  });
  assert.equal(puts.length, 1);
  assert.match(puts[0].route, /permissions\/role1/);
});

test('isTxnCommish reads transactions.commishUserIds from config', () => {
  const prev = loadConfig();
  saveConfig({
    ...prev,
    transactions: { ...prev.transactions, commishUserIds: ['681997817929007118'] },
  });
  assert.equal(isTxnCommish('681997817929007118'), true);
  assert.equal(isTxnCommish('392058697322463232'), false);
  saveConfig({
    ...prev,
    transactions: { ...prev.transactions, commishUserIds: prev.transactions.commishUserIds || [] },
  });
});
