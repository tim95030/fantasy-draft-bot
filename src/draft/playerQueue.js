const fs = require('fs');
const paths = require('../paths');
const { audit } = require('./audit');

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

function snapshot(entry) {
  return {
    autoDraft: Boolean(entry.autoDraft),
    fantraxIds: [...(entry.fantraxIds || [])],
    queueLen: (entry.fantraxIds || []).length,
  };
}

/** Every queue mutation goes through here so nothing is silent. */
function logChange(event, teamIndex, before, after, extra = {}) {
  audit(event, {
    teamIndex: teamIndex == null ? undefined : Number(teamIndex),
    before: before ? snapshot(before) : undefined,
    after: after ? snapshot(after) : undefined,
    ...extra,
  });
}

function classifyId(pool, id) {
  const player = pool.get(id);
  if (!player) return 'missing';
  if (player.taken) return 'taken';
  return 'available';
}

function addPlayer(teamIndex, fantraxId, meta = {}) {
  const before = getEntry(teamIndex);
  const entry = { ...before, fantraxIds: [...before.fantraxIds] };
  const id = String(fantraxId);
  if (entry.fantraxIds.includes(id)) {
    throw new Error('That player is already in your queue.');
  }
  if (entry.fantraxIds.length >= MAX_QUEUE) {
    throw new Error(`Queue is full (max ${MAX_QUEUE}). Remove someone first.`);
  }
  entry.fantraxIds.push(id);
  setEntry(teamIndex, entry);
  const after = getEntry(teamIndex);
  logChange('queue.add', teamIndex, before, after, { fantraxId: id, ...meta });
  return after;
}

function removeAt(teamIndex, position1Based, meta = {}) {
  const before = getEntry(teamIndex);
  const entry = { ...before, fantraxIds: [...before.fantraxIds] };
  const idx = Number(position1Based) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= entry.fantraxIds.length) {
    throw new Error(`No queue slot #${position1Based}.`);
  }
  const [removed] = entry.fantraxIds.splice(idx, 1);
  setEntry(teamIndex, entry);
  const after = getEntry(teamIndex);
  logChange('queue.remove', teamIndex, before, after, {
    fantraxId: removed,
    position: Number(position1Based),
    ...meta,
  });
  return removed;
}

function removePlayer(teamIndex, fantraxId, meta = {}) {
  const before = getEntry(teamIndex);
  const entry = { ...before, fantraxIds: [...before.fantraxIds] };
  const id = String(fantraxId);
  const idx = entry.fantraxIds.indexOf(id);
  if (idx < 0) throw new Error('That player is not in your queue.');
  entry.fantraxIds.splice(idx, 1);
  setEntry(teamIndex, entry);
  const after = getEntry(teamIndex);
  logChange('queue.remove', teamIndex, before, after, { fantraxId: id, ...meta });
  return id;
}

function move(teamIndex, from1, to1, meta = {}) {
  const before = getEntry(teamIndex);
  const entry = { ...before, fantraxIds: [...before.fantraxIds] };
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
  setEntry(teamIndex, entry);
  const after = getEntry(teamIndex);
  logChange('queue.move', teamIndex, before, after, {
    fantraxId: item,
    from: Number(from1),
    to: Number(to1),
    ...meta,
  });
  return after;
}

function clear(teamIndex, meta = {}) {
  const before = getEntry(teamIndex);
  const entry = { autoDraft: before.autoDraft, fantraxIds: [] };
  setEntry(teamIndex, entry);
  const after = getEntry(teamIndex);
  logChange('queue.clear', teamIndex, before, after, {
    removedIds: before.fantraxIds,
    ...meta,
  });
  return after;
}

function setAutoDraft(teamIndex, enabled, meta = {}) {
  const before = getEntry(teamIndex);
  const entry = { ...before, autoDraft: Boolean(enabled) };
  setEntry(teamIndex, entry);
  const after = getEntry(teamIndex);
  logChange('queue.autodraft', teamIndex, before, after, {
    enabled: after.autoDraft,
    ...meta,
  });
  return after;
}

/**
 * Drop missing/taken ids, persist if needed, return first remaining id (still in queue).
 */
function peekNextAvailable(teamIndex, pool) {
  const before = getEntry(teamIndex);
  const dropped = [];
  const pruned = [];
  for (const id of before.fantraxIds) {
    const why = classifyId(pool, id);
    if (why === 'available') pruned.push(id);
    else dropped.push({ fantraxId: id, why });
  }
  if (dropped.length) {
    const entry = { autoDraft: before.autoDraft, fantraxIds: pruned };
    setEntry(teamIndex, entry);
    const after = getEntry(teamIndex);
    logChange('queue.prune_peek', teamIndex, before, after, {
      dropped,
      reason: 'peek_next_available',
    });
  }
  return pruned[0] || null;
}

/**
 * Remove and return the first fantraxId that is still in the pool and not taken.
 * Drops missing/taken ids from the queue as it goes.
 */
function shiftNextAvailable(teamIndex, pool) {
  const before = getEntry(teamIndex);
  const entry = { autoDraft: before.autoDraft, fantraxIds: [...before.fantraxIds] };
  const dropped = [];
  let next = null;

  while (entry.fantraxIds.length) {
    const id = entry.fantraxIds.shift();
    const why = classifyId(pool, id);
    if (why === 'available') {
      next = id;
      break;
    }
    dropped.push({ fantraxId: id, why });
  }

  if (dropped.length || next !== null) {
    setEntry(teamIndex, entry);
    const after = getEntry(teamIndex);
    logChange('queue.shift', teamIndex, before, after, {
      selected: next,
      dropped,
      reason: 'shift_next_available',
    });
  }
  return next;
}

/**
 * Remove a drafted player from every team's queue.
 */
function removeFantraxIdFromAllQueues(fantraxId) {
  const id = String(fantraxId);
  const all = loadAll();
  const affected = [];
  let changed = false;
  for (const [key, raw] of Object.entries(all)) {
    if (!raw || typeof raw !== 'object') continue;
    const ids = Array.isArray(raw.fantraxIds) ? raw.fantraxIds.map(String) : [];
    if (!ids.includes(id)) continue;
    const before = {
      autoDraft: Boolean(raw.autoDraft),
      fantraxIds: ids,
    };
    const next = ids.filter((x) => x !== id);
    all[key] = {
      autoDraft: Boolean(raw.autoDraft),
      fantraxIds: next,
    };
    affected.push({
      teamIndex: Number(key),
      before: snapshot(before),
      after: snapshot(all[key]),
    });
    changed = true;
  }
  if (changed) {
    saveAll(all);
    audit('queue.purge_taken', {
      fantraxId: id,
      teams: affected.map((a) => a.teamIndex),
      affected,
    });
  }
  return changed;
}

/** Drop any already-taken / missing ids from all queues (startup hygiene). */
function pruneTakenFromAllQueues(pool) {
  const all = loadAll();
  const affected = [];
  let changed = false;
  let removed = 0;
  for (const [key, raw] of Object.entries(all)) {
    if (!raw || typeof raw !== 'object') continue;
    const ids = Array.isArray(raw.fantraxIds) ? raw.fantraxIds.map(String) : [];
    const dropped = [];
    const next = [];
    for (const id of ids) {
      const why = classifyId(pool, id);
      if (why === 'available') next.push(id);
      else dropped.push({ fantraxId: id, why });
    }
    if (!dropped.length) continue;
    const before = { autoDraft: Boolean(raw.autoDraft), fantraxIds: ids };
    all[key] = {
      autoDraft: Boolean(raw.autoDraft),
      fantraxIds: next,
    };
    removed += dropped.length;
    affected.push({
      teamIndex: Number(key),
      before: snapshot(before),
      after: snapshot(all[key]),
      dropped,
    });
    changed = true;
  }
  if (changed) {
    saveAll(all);
    audit('queue.prune_startup', { removed, affected });
  }
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
