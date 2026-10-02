const fs = require('fs');
const paths = require('../paths');

const MAX_QUEUE = 25;

function emptyEntry() {
  return { autoDraft: false, fantraxIds: [] };
}

function loadAll() {
  if (!fs.existsSync(paths.PLAYER_QUEUES_JSON)) {
    return {};
  }
  try {
    const raw = JSON.parse(fs.readFileSync(paths.PLAYER_QUEUES_JSON, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveAll(data) {
  fs.writeFileSync(paths.PLAYER_QUEUES_JSON, JSON.stringify(data, null, 2));
  return data;
}

function keyFor(teamIndex) {
  return String(teamIndex);
}

function getEntry(teamIndex) {
  const all = loadAll();
  const entry = all[keyFor(teamIndex)];
  if (!entry || typeof entry !== 'object') return emptyEntry();
  return {
    autoDraft: Boolean(entry.autoDraft),
    fantraxIds: Array.isArray(entry.fantraxIds)
      ? entry.fantraxIds.map(String)
      : [],
  };
}

function setEntry(teamIndex, entry) {
  const all = loadAll();
  all[keyFor(teamIndex)] = {
    autoDraft: Boolean(entry.autoDraft),
    fantraxIds: Array.isArray(entry.fantraxIds) ? entry.fantraxIds.map(String) : [],
  };
  saveAll(all);
  return getEntry(teamIndex);
}

function addPlayer(teamIndex, fantraxId) {
  const entry = getEntry(teamIndex);
  const id = String(fantraxId);
  if (entry.fantraxIds.includes(id)) {
    throw new Error('That player is already in your queue.');
  }
  if (entry.fantraxIds.length >= MAX_QUEUE) {
    throw new Error(`Queue is full (max ${MAX_QUEUE}). Remove someone first.`);
  }
  entry.fantraxIds.push(id);
  return setEntry(teamIndex, entry);
}

function removeAt(teamIndex, position1Based) {
  const entry = getEntry(teamIndex);
  const idx = Number(position1Based) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= entry.fantraxIds.length) {
    throw new Error(`No queue slot #${position1Based}.`);
  }
  const [removed] = entry.fantraxIds.splice(idx, 1);
  setEntry(teamIndex, entry);
  return removed;
}

function removePlayer(teamIndex, fantraxId) {
  const entry = getEntry(teamIndex);
  const id = String(fantraxId);
  const idx = entry.fantraxIds.indexOf(id);
  if (idx < 0) throw new Error('That player is not in your queue.');
  entry.fantraxIds.splice(idx, 1);
  setEntry(teamIndex, entry);
  return id;
}

function move(teamIndex, from1, to1) {
  const entry = getEntry(teamIndex);
  const from = Number(from1) - 1;
  const to = Number(to1) - 1;
  if (!Number.isInteger(from) || from < 0 || from >= entry.fantraxIds.length) {
    throw new Error(`No queue slot #${from1}.`);
  }
  if (!Number.isInteger(to) || to < 0 || to >= entry.fantraxIds.length) {
    throw new Error(`No queue slot #${to1}.`);
  }
  if (from === to) return entry;
  const [item] = entry.fantraxIds.splice(from, 1);
  entry.fantraxIds.splice(to, 0, item);
  return setEntry(teamIndex, entry);
}

function clear(teamIndex) {
  const entry = getEntry(teamIndex);
  entry.fantraxIds = [];
  return setEntry(teamIndex, entry);
}

function setAutoDraft(teamIndex, enabled) {
  const entry = getEntry(teamIndex);
  entry.autoDraft = Boolean(enabled);
  return setEntry(teamIndex, entry);
}

/**
 * Drop missing/taken ids, persist if needed, return first remaining id (still in queue).
 */
function peekNextAvailable(teamIndex, pool) {
  const entry = getEntry(teamIndex);
  const pruned = entry.fantraxIds.filter((id) => {
    const player = pool.get(id);
    return Boolean(player) && !player.taken;
  });
  if (pruned.length !== entry.fantraxIds.length) {
    entry.fantraxIds = pruned;
    setEntry(teamIndex, entry);
  }
  return pruned[0] || null;
}

/**
 * Remove and return the first fantraxId that is still in the pool and not taken.
 * Drops missing/taken ids from the queue as it goes.
 */
function shiftNextAvailable(teamIndex, pool) {
  const entry = getEntry(teamIndex);
  let changed = false;
  let next = null;

  while (entry.fantraxIds.length) {
    const id = entry.fantraxIds.shift();
    changed = true;
    const player = pool.get(id);
    if (!player) continue;
    if (player.taken) continue;
    next = id;
    break;
  }

  if (changed) setEntry(teamIndex, entry);
  return next;
}

/**
 * Remove a drafted player from every team's queue.
 */
function removeFantraxIdFromAllQueues(fantraxId) {
  const id = String(fantraxId);
  const all = loadAll();
  let changed = false;
  for (const [key, raw] of Object.entries(all)) {
    if (!raw || typeof raw !== 'object') continue;
    const ids = Array.isArray(raw.fantraxIds) ? raw.fantraxIds.map(String) : [];
    const next = ids.filter((x) => x !== id);
    if (next.length === ids.length) continue;
    all[key] = {
      autoDraft: Boolean(raw.autoDraft),
      fantraxIds: next,
    };
    changed = true;
  }
  if (changed) saveAll(all);
  return changed;
}

/** Drop any already-taken / missing ids from all queues (startup hygiene). */
function pruneTakenFromAllQueues(pool) {
  const all = loadAll();
  let changed = false;
  for (const [key, raw] of Object.entries(all)) {
    if (!raw || typeof raw !== 'object') continue;
    const ids = Array.isArray(raw.fantraxIds) ? raw.fantraxIds.map(String) : [];
    const next = ids.filter((id) => {
      const player = pool.get(id);
      return Boolean(player) && !player.taken;
    });
    if (next.length === ids.length) continue;
    all[key] = {
      autoDraft: Boolean(raw.autoDraft),
      fantraxIds: next,
    };
    changed = true;
  }
  if (changed) saveAll(all);
  return changed;
}

module.exports = {
  MAX_QUEUE,
  loadAll,
  getEntry,
  addPlayer,
  removeAt,
  removePlayer,
  move,
  clear,
  setAutoDraft,
  peekNextAvailable,
  shiftNextAvailable,
  removeFantraxIdFromAllQueues,
  pruneTakenFromAllQueues,
};
