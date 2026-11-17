const fantrax = require('../draft/fantrax');

async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Fantrax HTTP ${response.status}`);
  const data = await response.json();
  if (data?.error) throw new Error('Fantrax returned an error.');
  return data;
}

function parseTeam(data, teamId, teamName) {
  if (!Array.isArray(data?.tables)) throw new Error(`Missing roster tables for ${teamName}`);
  const statuses = { 1: 'ACTIVE', 2: 'RESERVE', 3: 'INJURED_RESERVE', 9: 'MINORS' };
  const items = [];
  for (const table of data.tables) {
    const headers = table.header?.cells || [];
    const contractIndex = headers.findIndex((c) => c.key === 'contract');
    if (!Array.isArray(table.rows) || contractIndex < 0) throw new Error(`Incomplete roster for ${teamName}`);
    for (const row of table.rows) {
      if (!row.scorer?.scorerId) continue;
      const status = statuses[row.statusId];
      if (!status || typeof row.cells?.[contractIndex]?.content !== 'string' || !row.cells[contractIndex].content.trim()) {
        throw new Error(`Unknown roster schema for ${teamName}`);
      }
      items.push({
        id: fantrax.normalizeFantraxId(row.scorer.scorerId),
        name: row.scorer.name,
        status,
        contract: row.cells[contractIndex].content.trim(),
        minorsEligible: typeof row.scorer.minorsEligible === 'boolean' ? row.scorer.minorsEligible : null,
      });
    }
  }
  const cap = fantrax.parseTeamCap(data);
  if (!cap || cap.cap <= 0 || cap.used < 0) throw new Error(`Missing cap totals for ${teamName}`);
  if (new Set(items.map((p) => p.id)).size !== items.length) throw new Error(`Duplicate roster rows for ${teamName}`);
  return { teamId, teamName, items, cap };
}

async function collect() {
  const leagueId = fantrax.getLeagueId();
  if (!leagueId) throw new Error('FANTRAX_LEAGUE_ID is not set');
  const league = await json(`https://www.fantrax.com/fxea/general/getLeagueInfo?leagueId=${encodeURIComponent(leagueId)}`);
  const teams = Object.values(league.teamInfo || {});
  if (teams.length !== 32) throw new Error(`Expected 32 Fantrax teams, received ${teams.length}`);
  const output = [];
  for (let index = 0; index < teams.length; index += 4) {
    const batch = await Promise.all(teams.slice(index, index + 4).map(async (team) => {
      const body = await json(`https://www.fantrax.com/fxpa/req?leagueId=${encodeURIComponent(leagueId)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgs: [{ method: 'getTeamRosterInfo', data: { leagueId, teamId: team.id, view: 'CONTRACT' } }] }),
      });
      return parseTeam(body.responses?.[0]?.data, String(team.id), String(team.name).trim());
    }));
    output.push(...batch);
  }
  return { leagueId, teams: output };
}

module.exports = { collect, parseTeam };
