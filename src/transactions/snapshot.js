const fs = require('fs');
const path = require('path');
const paths = require('../paths');
const fantrax = require('../draft/fantrax');
const { parseCsv } = require('../draft/players');
const { loadOrder, findTeamsForUser } = require('../draft/order');
const { audit } = require('../draft/audit');
const { playerLabel, contractLabel } = require('./format');

const REFRESH_MS = 60 * 60 * 1000;
const MINORS_CSV = path.join(paths.DATA, 'minors-status.csv');

let snap = null;
let timer = null;
let refreshing = null;

function fold(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** fantraxId (no `i` prefix) → { minors: 'Y'|'N'|'', round: '1'|'24'|'INELIGIBLE'|... } */
function loadMinorsStatus(file = MINORS_CSV) {
  const out = new Map();
  if (!fs.existsSync(file)) return out;
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const idx = {
    id: header.indexOf('fantraxid'),
    minors: header.indexOf('minorseligible'),
    round: header.indexOf('draftfromround'),
  };
  for (const r of rows.slice(1)) {
    const id = fantrax.normalizeFantraxId(r[idx.id]);
    if (!id) continue;
    out.set(id, {
      minors: String(r[idx.minors] || '').trim().toUpperCase(),
      round: String(r[idx.round] || '').trim().toUpperCase(),
    });
  }
  return out;
}

function buildLists(directory, ownership, minors) {
  const nhl = [];
  const ahl = [];
  for (const p of directory.values()) {
    if (ownership.byPlayerId.has(p.id)) continue;
    const m = minors.get(p.id);
    if (m?.round === '24') ahl.push(p);
    if (m?.minors !== 'Y') nhl.push(p);
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  return { nhl: nhl.sort(byName), ahl: ahl.sort(byName) };
}

async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const [directory, ownership] = await Promise.all([
      fantrax.fetchPlayerDirectory(),
      fantrax.fetchRosterOwnership({ force: true }),
    ]);
    const minors = loadMinorsStatus();
    const { nhl, ahl } = buildLists(directory, ownership, minors);
    snap = { at: Date.now(), directory, ownership, minors, nhl, ahl };
    audit('txn.snapshot', {
      players: directory.size,
      rostered: ownership.playerCount,
      nhl: nhl.length,
      ahl: ahl.length,
    });
    return snap;
  })();
  try {
    return await refreshing;
  } finally {
    refreshing = null;
  }
}

function start() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    refresh().catch((err) => console.error('Transaction snapshot refresh failed:', err.message));
  }, REFRESH_MS);
  return refresh().catch((err) => {
    console.error('Transaction snapshot refresh failed:', err.message);
  });
}

async function getSnapshot() {
  return snap || refresh();
}

/**
 * Ranked name search for autocomplete: prefix on any word beats substring,
 * and players with an NHL team beat `(N/A)` (mostly retired).
 */
function search(list, query, limit = 25) {
  const q = fold(query);
  if (q.length < 2) return [];
  const scored = [];
  for (const p of list) {
    const name = fold(p.name);
    const i = name.indexOf(q);
    if (i < 0) continue;
    const match = i === 0 ? 0 : name[i - 1] === ' ' ? 1 : 2;
    scored.push({ p, score: (p.team === '(N/A)' ? 3 : 0) + match });
  }
  scored.sort((a, b) => a.score - b.score || a.p.name.localeCompare(b.p.name));
  return scored.slice(0, limit).map((s) => s.p);
}

/** Draft teams (from draft-order.json) owned by a Discord user. */
function teamsForUser(userId) {
  return findTeamsForUser(loadOrder(), userId);
}

/** Fantrax roster for a draft team name (Canadians/Canadiens tolerant). */
function fantraxTeamFor(teamName, ownership) {
  const want = fantrax.normalizeTeamName(teamName);
  for (const t of ownership.teams.values()) {
    if (fantrax.normalizeTeamName(t.teamName) === want) return t;
  }
  return null;
}

/** Draft teams with no matching Fantrax roster, and vice versa. */
function teamMappingReport(ownership) {
  const draft = (loadOrder().teams || []).map((t) => String(t.teamName || '').trim());
  const fx = [...ownership.teams.values()].map((t) => t.teamName);
  const norm = (list) => new Set(list.map((n) => fantrax.normalizeTeamName(n)));
  const fxSet = norm(fx);
  const draftSet = norm(draft);
  return {
    draftWithoutFantrax: draft.filter((n) => !fxSet.has(fantrax.normalizeTeamName(n))),
    fantraxWithoutDraft: fx.filter((n) => !draftSet.has(fantrax.normalizeTeamName(n))),
  };
}

/** Roster rows for a Fantrax team with display info: label + contract. */
function rosterRows(team, directory) {
  return team.items
    .map((item) => {
      const info = directory.get(item.id) || {
        id: item.id,
        name: item.id,
        team: '',
        position: item.position,
      };
      return {
        ...info,
        position: info.position || item.position,
        item,
        label: playerLabel(info),
        contract: contractLabel(item),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
  REFRESH_MS,
  loadMinorsStatus,
  buildLists,
  refresh,
  start,
  getSnapshot,
  search,
  teamsForUser,
  fantraxTeamFor,
  teamMappingReport,
  rosterRows,
  fold,
};
