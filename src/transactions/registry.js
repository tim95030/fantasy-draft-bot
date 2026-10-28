const fs = require('fs');
const path = require('path');
const paths = require('../paths');
const fantrax = require('../draft/fantrax');
const { playerLabel } = require('./format');

const REGISTRY = path.join(paths.DATA, 'transactions.json');
const DROPS = path.join(paths.DATA, 'transaction-drops.json');
const HISTORY = path.join(paths.DATA, 'transactions-history.jsonl');

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

/** Remove a registry row so the player can be transacted fresh; the old row is kept in HISTORY. */
function retireEntry(kind, playerId, reason) {
  const reg = loadRegistry();
  const key = registryKey(kind, playerId);
  const prev = reg[key];
  if (!prev) return null;
  fs.appendFileSync(
    HISTORY,
    `${JSON.stringify({ retiredAt: new Date().toISOString(), reason, key, ...prev })}\n`,
  );
  delete reg[key];
  saveRegistry(reg);
  return prev;
}

function entryByThreadId(threadId) {
  const reg = loadRegistry();
  return Object.values(reg).find((e) => e.threadId === String(threadId)) || null;
}

function listOpenAuctions(kind = 'nhl') {
  const reg = loadRegistry();
  return Object.values(reg).filter((e) => e.kind === kind && e.status === 'open');
}

function looksLikeFantraxId(raw) {
  const t = fantrax.normalizeFantraxId(raw);
  return /^[0-9a-z]{4,12}$/i.test(t);
}

function resolvePlayer(playerId, snap, kind = 'nhl') {
  const id = fantrax.normalizeFantraxId(playerId);
  const fromDir = snap?.directory?.get(id);
  if (fromDir) return fromDir;
  const entry = getEntry(kind, id);
  return entry?.player || null;
}

/**
 * Slash `player` option: Fantrax id from autocomplete, or an exact name match
 * (common when mobile users type instead of selecting).
 */
function resolvePlayerFromInput(raw, snap, kind = 'nhl', searchFn) {
  const text = String(raw || '').trim();
  if (!text) return { error: 'Pick a player from autocomplete.' };

  if (looksLikeFantraxId(text)) {
    const id = fantrax.normalizeFantraxId(text);
    const player = resolvePlayer(id, snap, kind);
    if (player) return { player, id: player.id };
  }

  const q = fold(text);
  const seen = new Set();
  const candidates = [];
  if (kind === 'nhl') {
    for (const entry of listOpenAuctions('nhl')) {
      if (entry.player && !seen.has(entry.player.id)) {
        candidates.push(entry.player);
        seen.add(entry.player.id);
      }
    }
  }
  const pool = kind === 'nhl' ? snap?.nhl || [] : snap?.ahl || [];
  for (const p of pool) {
    if (!seen.has(p.id)) {
      candidates.push(p);
      seen.add(p.id);
    }
  }

  const exact = candidates.filter(
    (p) => fold(p.name) === q || fold(playerLabel(p)) === q,
  );
  if (exact.length === 1) return { player: exact[0], id: exact[0].id };
  if (exact.length > 1) {
    return {
      error: `Multiple players match **${text}**. Pick one from autocomplete (active auctions show with 🔨).`,
    };
  }

  if (searchFn && q.length >= 2) {
    const hits = searchFn(pool, text, 5);
    if (hits.length === 1) return { player: hits[0], id: hits[0].id };
  }

  const open = kind === 'nhl' ? listOpenAuctions('nhl') : [];
  if (open.length === 1 && open[0].player) {
    return { player: open[0].player, id: open[0].player.id };
  }

  return {
    error:
      'Player not found. Choose from autocomplete (do not type the name manually). Active NHL auctions show with 🔨.',
  };
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
  HISTORY,
  loadRegistry,
  saveRegistry,
  registryKey,
  getEntry,
  upsertEntry,
  retireEntry,
  entryByThreadId,
  listOpenAuctions,
  looksLikeFantraxId,
  resolvePlayer,
  resolvePlayerFromInput,
  loadDrops,
  recordDrop,
  dropBlocked,
  searchNhlAutocomplete,
};
