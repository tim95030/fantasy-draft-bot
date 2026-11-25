const DAY = 86_400_000;
const stamp = (at) => `<t:${Math.floor(at / 1000)}:f>`;
const name = (text) => String(text).replace(/[\\*_`~|<>\[\]\r\n]/g, '').slice(0, 44);

function report(state, settings, inactiveDays = settings.inactiveDays, now = Date.now()) {
  const stale = !state?.lastScanAt || Boolean(state.lastError) ||
    now - state.lastScanAt > settings.intervalMinutes * 2 * 60_000;
  const usable = settings.enabled && !stale;
  const teams = [...(state?.teams || [])].sort((a, b) =>
    (a.lastChange?.at ?? Infinity) - (b.lastChange?.at ?? Infinity) || a.teamName.localeCompare(b.teamName));
  let count = 0;
  const lines = teams.map((team) => {
    const change = team.lastChange;
    if (!change) return `**${name(team.teamName)}** — no recorded change in available history`;
    const elapsed = Math.max(0, now - change.at) / DAY;
    const flagged = usable && elapsed >= inactiveDays;
    if (flagged) count++;
    const periods = change.periods.slice(0, 4).join(', ') + (change.periods.length > 4 ? ', …' : '');
    return `**${name(team.teamName)}**${flagged ? ' — review' : ''}\n` +
      `${stamp(change.at)} · ${elapsed.toFixed(1)} days · period${change.periods.length === 1 ? '' : 's'} ${periods}`;
  });
  const embeds = [];
  for (let index = 0; index < lines.length; index += 16) {
    embeds.push({ title: `Last recorded lineup changes (${index + 1}–${Math.min(index + 16, lines.length)})`,
      description: lines.slice(index, index + 16).join('\n\n'), color: usable ? 0x3498db : 0x888888 });
  }
  return { allowedMentions: { parse: [] }, embeds, content:
    `**Lineup activity — private report**\n` +
    `Checks: ${settings.enabled ? `every ${settings.intervalMinutes} minutes` : 'paused'}. ` +
    `Review threshold: ${inactiveDays} days.\n` +
    `Last successful check: ${state?.lastScanAt ? stamp(state.lastScanAt) : 'none'}.\n` +
    (!usable ? '**Data unavailable/stale or checks paused; inactivity is not assessed.**\n' :
      `${count}/${teams.length} teams meet the review threshold.\n`) +
    'Times record a team lineup change, including changes for future periods. An unchanged review may leave no record; owner/commish authorship is unavailable.\n' +
    '[Fantrax lineup history](https://www.fantrax.com/fantasy/league/' + encodeURIComponent(state?.leagueId || '') + '/transactions/history;view=LINEUP_CHANGE)' };
}
module.exports = { report };
