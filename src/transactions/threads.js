const fs = require('fs');
const path = require('path');
const paths = require('../paths');
const { parseBidFromMessage } = require('./format');

const REGISTRY = path.join(paths.DATA, 'transactions.json');
const AUTO_ARCHIVE_MIN = 10080;
const MAX_SCAN_MESSAGES = 1000;

function loadRegistry() {
  if (!fs.existsSync(REGISTRY)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveRegistry(data) {
  fs.writeFileSync(REGISTRY, JSON.stringify(data, null, 2));
}

function registryKey(kind, playerId) {
  return `${kind}:${playerId}`;
}

const locks = new Map();

/** Serialize work per key so two bids on one player can't interleave. */
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

/** Registered thread if it still exists under the expected channel. */
async function findThread(client, kind, playerId, channelId) {
  const entry = loadRegistry()[registryKey(kind, playerId)];
  if (!entry || entry.channelId !== channelId) return null;
  try {
    const thread = await client.channels.fetch(entry.threadId);
    if (!thread || thread.parentId !== channelId) return null;
    return thread;
  } catch {
    return null;
  }
}

async function createThread(channel, { kind, playerId, title, reason }) {
  const thread = await channel.threads.create({
    name: title.slice(0, 100),
    autoArchiveDuration: AUTO_ARCHIVE_MIN,
    reason,
  });
  const reg = loadRegistry();
  reg[registryKey(kind, playerId)] = {
    threadId: thread.id,
    channelId: channel.id,
    title: thread.name,
    createdAt: new Date().toISOString(),
  };
  saveRegistry(reg);
  return thread;
}

async function postInThread(thread, content, mentionUserIds = []) {
  if (thread.archived) {
    await thread.setArchived(false).catch(() => {});
  }
  return thread.send({ content, allowedMentions: { users: mentionUserIds } });
}

/** Largest amount at the start of any message in the thread (bot or typed). */
async function highestBid(thread) {
  let best = 0;
  let before;
  let scanned = 0;
  while (scanned < MAX_SCAN_MESSAGES) {
    const batch = await thread.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    for (const msg of batch.values()) {
      const amount = parseBidFromMessage(msg.content);
      if (amount && amount > best) best = amount;
    }
    scanned += batch.size;
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return best;
}

module.exports = {
  REGISTRY,
  loadRegistry,
  registryKey,
  withLock,
  findThread,
  createThread,
  postInThread,
  highestBid,
};
