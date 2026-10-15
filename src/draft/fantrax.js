/**
 * Read-only Fantrax helpers (roster → player/team map).
 * Player ids from the API omit the sheet `i` prefix used in Discord CSVs.
 */

const CACHE_MS = 60_000;
let _cache = null;

function normalizeFantraxId(value) {
  const text = String(value || '')
    .trim()
    .replace(/^\*/, '');
  if (!text) return '';
  if (text[0] === 'i' && text.length > 1) return text.slice(1);
  return text;
}

function sheetFantraxId(value) {
  const raw = normalizeFantraxId(value);
  return raw ? `i${raw}` : '';
}

function normalizeTeamName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\bcanadians\b/g, 'canadiens');
}

function getLeagueId() {
  return String(process.env.FANTRAX_LEAGUE_ID || '').trim();
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'fantasy-draft-bot/1.0 (+discord)',
    },
  });
  if (!res.ok) {
    throw new Error(`Fantrax HTTP ${res.status} for ${url}`);
  }
  const data = await res.json();
  if (data && typeof data === 'object' && data.error) {
    throw new Error(`Fantrax API error: ${data.error}`);
  }
  return data;
}

/**
 * @returns {Promise<{ leagueId: string, period: any, byPlayerId: Map<string, string>, teamCount: number, playerCount: number }>}
 */
async function fetchRosterOwnership({ force = false } = {}) {
  const leagueId = getLeagueId();
  if (!leagueId) {
    throw new Error('FANTRAX_LEAGUE_ID is not set in .env');
  }

  if (
    !force &&
    _cache &&
    _cache.leagueId === leagueId &&
    Date.now() - _cache.at < CACHE_MS
  ) {
    return _cache.data;
  }

  const url = `https://www.fantrax.com/fxea/general/getTeamRosters?leagueId=${encodeURIComponent(leagueId)}`;
  const data = await fetchJson(url);
  const rosters = data.rosters && typeof data.rosters === 'object' ? data.rosters : {};
  const byPlayerId = new Map();
  /** @type {Map<string, { id: string, teamName: string, contract: string, salary: number|null, status: string, position: string }>} */
  const itemsById = new Map();
  /** @type {Map<string, { teamId: string, teamName: string, items: any[] }>} */
  const teams = new Map();

  for (const [teamId, roster] of Object.entries(rosters)) {
    if (!roster || typeof roster !== 'object') continue;
    const teamName = String(roster.teamName || '').trim();
    const items = Array.isArray(roster.rosterItems) ? roster.rosterItems : [];
    const team = { teamId, teamName, items: [] };
    teams.set(teamId, team);
    for (const item of items) {
      const id = normalizeFantraxId(item?.id);
      if (!id || !teamName) continue;
      byPlayerId.set(id, teamName);
      const salary = Number(item.salary);
      const entry = {
        id,
        teamName,
        contract: String(item.contract?.name || '').trim(),
        salary: Number.isFinite(salary) && salary > 0 ? salary : null,
        status: String(item.status || ''),
        position: String(item.position || ''),
      };
      itemsById.set(id, entry);
      team.items.push(entry);
    }
  }

  const result = {
    leagueId,
    period: data.period ?? null,
    byPlayerId,
    itemsById,
    teams,
    teamCount: Object.keys(rosters).length,
    playerCount: byPlayerId.size,
  };
  _cache = { leagueId, at: Date.now(), data: result };
  return result;
}

/** `"Smith, Joe"` → `"Joe Smith"`; names without a comma pass through. */
function displayName(raw) {
  const text = String(raw || '').trim();
  const idx = text.indexOf(',');
  if (idx < 0) return text;
  const last = text.slice(0, idx).trim();
  const first = text.slice(idx + 1).trim();
  return first ? `${first} ${last}` : last;
}

/**
 * Every NHL player Fantrax knows about (no login needed).
 * @returns {Promise<Map<string, { id: string, name: string, team: string, position: string }>>}
 */
async function fetchPlayerDirectory() {
  const data = await fetchJson('https://www.fantrax.com/fxea/general/getPlayerIds?sport=NHL');
  const out = new Map();
  for (const p of Object.values(data || {})) {
    const id = normalizeFantraxId(p?.fantraxId);
    if (!id) continue;
    out.set(id, {
      id,
      name: displayName(p.name),
      team: String(p.team || '').trim() || '(N/A)',
      position: String(p.position || '').trim().replace(/^Default$/i, ''),
    });
  }
  return out;
}

/** @returns {Promise<{ id: string, name: string }[]>} */
async function fetchLeagueTeams() {
  const leagueId = getLeagueId();
  if (!leagueId) throw new Error('FANTRAX_LEAGUE_ID is not set in .env');
  const data = await fetchJson(
    `https://www.fantrax.com/fxea/general/getLeagueInfo?leagueId=${encodeURIComponent(leagueId)}`,
  );
  return Object.values(data.teamInfo || {}).map((t) => ({
    id: String(t.id),
    name: String(t.name || '').trim(),
  }));
}

/**
 * Compare Discord picks to Fantrax roster ownership.
 */
function diffPicksAgainstRosters(picks, ownership) {
  const pending = [];
  const wrongTeam = [];
  let ok = 0;

  for (const p of picks || []) {
    const id = normalizeFantraxId(p.fantraxId);
    if (!id) continue;
    const expected = String(p.teamName || p.displayName || '').trim();
    const actual = ownership.byPlayerId.get(id);
    const row = {
      round: p.round,
      pick: p.pick,
      fantraxId: sheetFantraxId(id),
      playerName: p.playerName || '',
      position: p.position || '',
      nhlTeam: p.team || '',
      discordTeam: expected,
      fantraxTeam: actual || null,
    };

    if (!actual) {
      pending.push(row);
      continue;
    }
    if (normalizeTeamName(actual) !== normalizeTeamName(expected)) {
      wrongTeam.push(row);
      continue;
    }
    ok += 1;
  }

  const sortKey = (a, b) => a.round - b.round || a.pick - b.pick;
  pending.sort(sortKey);
  wrongTeam.sort(sortKey);

  return {
    ok,
    pending,
    wrongTeam,
    discordTotal: (picks || []).length,
    fantraxPlayers: ownership.playerCount,
    fantraxTeams: ownership.teamCount,
  };
}

function formatPickLine(row) {
  let label = row.playerName || 'Unknown';
  if (row.position && row.nhlTeam) label = `${row.playerName} ${row.position}, ${row.nhlTeam}`;
  else if (row.position) label = `${row.playerName} ${row.position}`;
  return `${row.round}.${row.pick} ${label} (\`${row.fantraxId}\`)`;
}

module.exports = {
  normalizeFantraxId,
  sheetFantraxId,
  normalizeTeamName,
  getLeagueId,
  displayName,
  fetchRosterOwnership,
  fetchPlayerDirectory,
  fetchLeagueTeams,
  diffPicksAgainstRosters,
  formatPickLine,
};
