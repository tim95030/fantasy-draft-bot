const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ensureCommishThreadAccess, addUsersToThreadMembers } = require('./threadPerms');
const { isTxnCommish, loadConfig, saveConfig } = require('../config');

test('ensureCommishThreadAccess adds commish to thread members', async () => {
  const memberAdds = [];
  const thread = {
    guild: { id: 'g1' },
    archived: false,
    setArchived: async () => {},
    members: { add: async (id) => memberAdds.push(id) },
  };
  const ok = await ensureCommishThreadAccess(thread, ['681997817929007118']);
  assert.equal(ok, true);
  assert.deepEqual(memberAdds, ['681997817929007118']);
});

test('addUsersToThreadMembers continues after a failure', async () => {
  const memberAdds = [];
  const thread = {
    members: {
      add: async (id) => {
        if (id === 'bad') throw new Error('nope');
        memberAdds.push(id);
      },
    },
  };
  await addUsersToThreadMembers(thread, ['bad', 'good']);
  assert.deepEqual(memberAdds, ['good']);
});

test('isTxnCommish reads transactions.commishUserIds from config', () => {
  const prev = loadConfig();
  saveConfig({
    ...prev,
    transactions: { ...prev.transactions, commishUserIds: ['681997817929007118'] },
  });
  assert.equal(isTxnCommish('681997817929007118'), true);
  saveConfig({
    ...prev,
    transactions: { ...prev.transactions, commishUserIds: prev.transactions.commishUserIds || [] },
  });
});
