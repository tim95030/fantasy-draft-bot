const registry = require('./registry');
const { parseBidFromMessage } = require('./bids');

const AUTO_ARCHIVE_MIN = 10080;
const MAX_SCAN_MESSAGES = 1000;

const locks = new Map();

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

async function findThread(client, kind, playerId, channelId) {
  const entry = registry.getEntry(kind, playerId);
  if (!entry || entry.channelId !== channelId) return null;
  try {
    const thread = await client.channels.fetch(entry.threadId);
    if (!thread || thread.parentId !== channelId) return null;
    return thread;
  } catch {
    return null;
  }
}

async function createThread(channel, { kind, playerId, title, reason, meta = {} }) {
  const thread = await channel.threads.create({
    name: title.slice(0, 100),
    autoArchiveDuration: AUTO_ARCHIVE_MIN,
    reason,
  });
  registry.upsertEntry(kind, playerId, {
    threadId: thread.id,
    channelId: channel.id,
    title: thread.name,
    createdAt: new Date().toISOString(),
    kind,
    ...meta,
  });
  return thread;
}

async function postInThread(thread, content, mentionUserIds = []) {
  if (thread.archived) {
    await thread.setArchived(false).catch(() => {});
  }
  return thread.send({ content, allowedMentions: { users: mentionUserIds } });
}

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
  REGISTRY: registry.REGISTRY,
  loadRegistry: registry.loadRegistry,
  registryKey: registry.registryKey,
  withLock,
  findThread,
  createThread,
  postInThread,
  highestBid,
};
