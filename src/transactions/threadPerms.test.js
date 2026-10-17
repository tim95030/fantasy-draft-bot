const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits, OverwriteType } = require('discord.js');
const { COMMISH_THREAD_ALLOW, ensureCommishThreadAccess } = require('./threadPerms');
const { isTxnCommish, loadConfig, saveConfig, DEFAULTS } = require('../config');

test('COMMISH_THREAD_ALLOW grants view, send in threads, and manage threads', () => {
  assert.ok(COMMISH_THREAD_ALLOW.includes(PermissionFlagsBits.ViewChannel));
  assert.ok(COMMISH_THREAD_ALLOW.includes(PermissionFlagsBits.SendMessagesInThreads));
  assert.ok(COMMISH_THREAD_ALLOW.includes(PermissionFlagsBits.ManageThreads));
});

test('ensureCommishThreadAccess creates member overwrites for each commish id', async () => {
  const created = [];
  const thread = {
    guild: { id: 'g1' },
    archived: false,
    setArchived: async () => {},
    permissionOverwrites: {
      cache: new Map(),
      create: async (opts) => {
        created.push(opts);
      },
    },
  };
  const ok = await ensureCommishThreadAccess(thread, ['111', '222']);
  assert.equal(ok, true);
  assert.equal(created.length, 2);
  assert.deepEqual(created[0], {
    id: '111',
    type: OverwriteType.Member,
    allow: COMMISH_THREAD_ALLOW,
  });
  assert.deepEqual(created[1].id, '222');
});

test('ensureCommishThreadAccess edits existing overwrites', async () => {
  const edits = [];
  const memberId = '333';
  const existing = {
    edit: async (opts) => {
      edits.push(opts);
    },
  };
  const thread = {
    guild: { id: 'g1' },
    archived: false,
    setArchived: async () => {},
    permissionOverwrites: {
      cache: new Map([[memberId, existing]]),
      create: async () => {
        throw new Error('should not create');
      },
    },
  };
  await ensureCommishThreadAccess(thread, [memberId]);
  assert.equal(edits.length, 1);
  assert.deepEqual(edits[0], { allow: COMMISH_THREAD_ALLOW, deny: [] });
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
