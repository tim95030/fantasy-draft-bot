const fs = require('fs');
const path = require('path');
const paths = require('../paths');
const fantrax = require('../draft/fantrax');
const { playerLabel } = require('./format');

const REGISTRY = path.join(paths.DATA, 'transactions.json');
const DROPS = path.join(paths.DATA, 'transaction-drops.json');

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
  return `${kind}:${fantrax.normalizeFantraxId(playerId)}`;
}

function getEntry(kind, playerId) {
  return loadRegistry()[registryKey(kind, playerId)] || null;
}

function upsertEntry(kind, playerId, patch) {
  const reg = loadRegistry();
  const key = registryKey(kind, playerId);
  const prev = reg[key] || {};
  reg[key] = { ...prev, ...patch, kind, playerId: fantrax.normalizeFantraxId(playerId) };
  saveRegistry(reg);
  return reg[key];
}

function listOpenAuctions(kind = 'nhl') {
  const reg = loadRegistry();
  return Object.values(reg).filter((e) => e.kind === kind && e.status === 'open');
}

function resolvePlayer(playerId, snap, kind = 'nhl') {
  const id = fantrax.normalizeFantraxId(playerId);
  const fromDir = snap?.directory?.get(id);
  if (fromDir) return fromDir;
  const entry = getEntry(kind, id);
  return entry?.player || null;
}

function loadDrops() {
  if (!fs.existsSync(DROPS)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(DROPS, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveDrops(rows) {
  fs.writeFileSync(DROPS, JSON.stringify(rows, null, 2));
}

function recordDrop({ teamName, playerId, playerName }) {
  const rows = loadDrops();
  rows.push({
    teamName,
    playerId: fantrax.normalizeFantraxId(playerId),
    playerName,
    at: new Date().toISOString(),
  });
  saveDrops(rows);
}

function dropBlocked(teamName, playerId, hours = 48) {
  const id = fantrax.normalizeFantraxId(playerId);
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return loadDrops().some(
    (d) =>
      d.playerId === id &&
      String(d.teamName).toLowerCase() === String(teamName).toLowerCase() &&
      Date.parse(d.at) >= cutoff,
  );
}

function fold(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** NHL autocomplete: open auctions first, then pool; works with 0–1 char query. */
function searchNhlAutocomplete(snap, query, searchFn) {
  const q = fold(query);
  const seen = new Set();
  const out = [];

  const matches = (p) => {
    if (!q || q.length < 2) return true;
    const label = fold(playerLabel(p));
    return fold(p.name).includes(q) || label.includes(q);
  };

  for (const entry of listOpenAuctions('nhl')) {
    const p =
      entry.player ||
      (snap?.directory?.get(entry.playerId)
        ? { ...snap.directory.get(entry.playerId) }
        : entry.playerId
          ? { id: entry.playerId, name: entry.title || entry.playerId, team: '', position: '' }
          : null);
    if (!p || seen.has(p.id) || !matches(p)) continue;
    seen.add(p.id);
    out.push({ ...p, _auction: true });
    if (out.length >= 25) return out;
  }

  if (q.length >= 2) {
    for (const p of searchFn(snap.nhl, query)) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
      if (out.length >= 25) break;
    }
  }
  return out;
}

module.exports = {
  REGISTRY,
  DROPS,
  loadRegistry,
  saveRegistry,
  registryKey,
  getEntry,
  upsertEntry,
  listOpenAuctions,
  resolvePlayer,
  loadDrops,
  recordDrop,
  dropBlocked,
  searchNhlAutocomplete,
};
