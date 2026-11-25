const { getLeagueId } = require('../draft/fantrax');

const OFFSETS = { EST: -300, EDT: -240, UTC: 0, GMT: 0, PST: -480, PDT: -420 };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseDate(value, zone) {
  const match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) ([A-Z][a-z]{2}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2})(AM|PM)$/.exec(value || '');
  if (!match || !Object.hasOwn(OFFSETS, zone)) throw new Error('Unsupported lineup history timestamp or time zone');
  const [, weekday, month, day, year, hour, minute, half] = match;
  const h = Number(hour), m = Number(minute), monthIndex = MONTHS.indexOf(month);
  if (h < 1 || h > 12 || m > 59 || monthIndex < 0) throw new Error('Invalid lineup history timestamp');
  const local = new Date(Date.UTC(Number(year), monthIndex, Number(day), h % 12 + (half === 'PM' ? 12 : 0), m));
  if (local.getUTCFullYear() !== Number(year) || local.getUTCMonth() !== monthIndex || local.getUTCDate() !== Number(day) ||
      ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][local.getUTCDay()] !== weekday) {
    throw new Error('Invalid lineup history date');
  }
  return local.getTime() - OFFSETS[zone] * 60_000;
}

function parseHistory(data, team, now = Date.now()) {
  const page = data?.paginatedResultSet;
  const rows = data?.table?.rows;
  if (!Array.isArray(rows) || !Number.isInteger(page?.totalNumResults) || page.totalNumResults < 0 ||
      !Number.isInteger(page.maxResultsPerPage) || page.maxResultsPerPage < 1 ||
      page.pageNumber !== 1 || data.displayedSelections?.team !== team.id ||
      data.displayedSelections?.view !== 'LINEUP_CHANGE' || data.displayedSelections?.includeDeleted !== false ||
      data.displayedSelections?.executedOnly !== true) throw new Error(`Incomplete lineup history for ${team.name}`);
  if (!rows.length && page.totalNumResults !== 0) throw new Error(`Missing lineup history for ${team.name}`);
  const zone = /\(([A-Z]+)\)$/.exec(data.table.header?.cells?.find((c) => c.key === 'date')?.name || '')?.[1];
  if (!Object.hasOwn(OFFSETS, zone)) throw new Error('Unsupported lineup history time zone');
  const groups = new Map();
  for (const row of rows) {
    const cells = Object.fromEntries((row.cells || []).map((c) => [c.key, c]));
    if (cells.team?.teamId !== team.id || !row.txSetId || row.deleted !== false || row.executed !== true) {
      throw new Error(`Unexpected lineup history row for ${team.name}`);
    }
    const group = groups.get(row.txSetId) || { transactionId: row.txSetId, periods: [] };
    if (cells.date) {
      const at = parseDate(cells.date.content, zone);
      if (at > now + 5 * 60_000) throw new Error('Lineup history processed time is in the future');
      if (group.at !== undefined && group.at !== at) throw new Error('Inconsistent lineup transaction timestamps');
      group.at = at;
    }
    if (!/^\d+$/.test(cells.weekOrPeriod?.content || '')) throw new Error('Missing lineup scoring period');
    group.periods.push(Number(cells.weekOrPeriod.content));
    groups.set(row.txSetId, group);
  }
  const changes = [...groups.values()];
  if (changes.some((g) => !Number.isFinite(g.at))) throw new Error('Missing lineup transaction timestamp');
  if (changes.length !== Math.min(page.totalNumResults, page.maxResultsPerPage)) throw new Error('Incomplete lineup transaction groups');
  if (changes.some((g, i) => i > 0 && g.at > changes[i - 1].at)) throw new Error('Lineup history is not newest first');
  const latest = changes[0];
  return { teamId: team.id, teamName: team.name, lastChange: latest ? {
    ...latest, periods: [...new Set(latest.periods)].sort((a, b) => a - b),
  } : null };
}

async function request(url, options, fetcher) {
  const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Fantrax HTTP ${response.status}`);
  const body = await response.json();
  if (body?.error || body?.pageError || body?.responses?.some((r) => r.error || r.pageError)) throw new Error('Fantrax lineup history unavailable');
  return body;
}

async function collect({ leagueId = getLeagueId(), fetcher = fetch, now = Date.now() } = {}) {
  if (!leagueId) throw new Error('FANTRAX_LEAGUE_ID is not set');
  const league = await request(`https://www.fantrax.com/fxea/general/getLeagueInfo?leagueId=${encodeURIComponent(leagueId)}`, {}, fetcher);
  const teams = Object.values(league.teamInfo || {});
  if (teams.length !== 32 || new Set(teams.map((t) => t.id)).size !== 32 || teams.some((t) => !t.id || !t.name)) {
    throw new Error('Incomplete lineup league team list');
  }
  const output = [];
  for (let index = 0; index < teams.length; index += 4) {
    const batch = await Promise.allSettled(teams.slice(index, index + 4).map(async (team) => {
      const body = await request(`https://www.fantrax.com/fxpa/req?leagueId=${encodeURIComponent(leagueId)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgs: [{ method: 'getTransactionDetailsHistory', data: {
          leagueId, view: 'LINEUP_CHANGE', team: team.id, pageNumber: 1, positionOrGroup: 'ALL',
          executedOnly: true, includeDeleted: false,
        } }] }),
      }, fetcher);
      return parseHistory(body.responses?.[0]?.data, team, now);
    }));
    const failure = batch.find((r) => r.status === 'rejected');
    if (failure) throw failure.reason;
    output.push(...batch.map((r) => r.value));
  }
  return { leagueId, teams: output };
}

module.exports = { collect, parseDate, parseHistory };
