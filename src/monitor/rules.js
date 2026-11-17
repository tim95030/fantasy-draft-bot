const { normalizeTeamName } = require('../draft/fantrax');
const { countRoster, pendingDropIds, rosterLimits } = require('../transactions/roster');

const HOUR = 3_600_000;
const pro = (p) => ['ACTIVE', 'RESERVE'].includes(p.status);
const minorsContract = (p) => p.contract.toLowerCase() === 'minors';

/** Evaluate current conditions without changing Fantrax or transaction state. */
function evaluate({ teams, previous = {}, records, drops, settings, txnConfig, now }) {
  const conditions = [];
  const next = {};
  const add = (team, type, player, detail, remedy, graceHours = 0) => {
    conditions.push({ key: `${team.teamId}:${type}:${player?.id || 'roster'}`, teamId: team.teamId,
      teamName: team.teamName, type, playerId: player?.id, detail, remedy, graceHours });
  };
  for (const team of teams) {
    const old = previous[team.teamId];
    const priorItems = new Map((old?.items || []).map((p) => [p.id, p]));
    const tracked = [];
    const sameTeam = (name) => normalizeTeamName(name) === normalizeTeamName(team.teamName);
    const minorsCount = team.items.filter((p) => p.status === 'MINORS').length;
    for (const item of team.items) {
      const before = priorItems.get(item.id);
      const lastDrop = Math.max(0, ...drops.filter((d) => d.playerId === item.id && sameTeam(d.teamName))
        .map((d) => Date.parse(d.at)).filter(Number.isFinite));
      const resetTenure = before && lastDrop > (old?.at || 0);
      const receipt = records.some((r) => r.kind === 'callup' && r.playerId === item.id && sameTeam(r.teamName) &&
        Date.parse(r.createdAt || r.at || '') > lastDrop && r.threadId);
      const requiresCallup = !resetTenure && (before?.requiresCallup ||
        (before && minorsContract(before) && pro(item) && before.status === 'MINORS'));
      const promoted = !resetTenure && (before?.promoted || (before && pro(before) && !minorsContract(before)));
      const reserveGraceUntil = !resetTenure && (before?.reserveGraceUntil ||
        (!before && old && item.status === 'RESERVE' && minorsContract(item) && minorsCount >= 30
          ? now + settings.rosterGraceHours * HOUR : 0));
      const inReserveGrace = item.status === 'RESERVE' && reserveGraceUntil > now && !promoted && !receipt;
      tracked.push({ ...item, requiresCallup: Boolean(requiresCallup), promoted: Boolean(promoted || receipt ||
        (settings.seasonActive && pro(item) && !inReserveGrace && (minorsContract(item) || requiresCallup))), reserveGraceUntil });

      if (settings.seasonActive && pro(item) && !inReserveGrace && !receipt && (minorsContract(item) || requiresCallup)) {
        add(team, 'missing_callup', item, `${item.name} is on the NHL roster without a matching /minors-callup record.`,
          `Use /minors-callup player:${item.id} for_team:${team.teamName}. If the contract is already pro, ask the commish to backfill it. A callup cannot be undone by sending the player down.`);
      }
      if (item.status === 'MINORS' && (!minorsContract(item) || (settings.seasonActive && promoted))) {
        add(team, 'illegal_senddown', item, `${item.name} is in minors with ${!minorsContract(item) ? `a ${item.contract} pro contract` : 'an observed prior promotion'}.`,
          'Move the player out of minors and ask the commish to confirm the contract. Do not drop/re-add to evade the 48-hour rule.');
      }
      // A midseason threshold crossing does not invalidate an incumbent's right to stay until next Opening Night.
      if (item.status === 'MINORS' && minorsContract(item) && item.minorsEligible === false &&
          ((!before && old) || before?.ineligibleAcquisition)) {
        tracked.at(-1).ineligibleAcquisition = true;
        add(team, 'ineligible_minor_add', item, `${item.name} was newly acquired into minors but Fantrax marks them non-minors-eligible.`,
          'Ask the commish to correct the acquisition or roster placement. Existing prospects crossing the threshold midseason are not flagged.');
      }
      const reacquired = (!before && old) || before?.reacquiredAt;
      const acquiredAt = before?.reacquiredAt || now;
      if (reacquired && lastDrop && acquiredAt - lastDrop >= 0 && acquiredAt - lastDrop < (txnConfig.dropCooldownHours ?? 48) * HOUR &&
          (item.status === 'MINORS' || minorsContract(item))) {
        tracked.at(-1).reacquiredAt = acquiredAt;
        add(team, 'drop_cooldown', item, `${item.name} was reacquired inside your team's ${txnConfig.dropCooldownHours ?? 48}-hour drop cooldown.`,
          'Contact the commish to review or reverse the acquisition. Waiting out the clock does not legalize an early acquisition.');
      }
    }
    const counts = countRoster(team.items, { exclude: pendingDropIds(drops, team.teamName, team.items, now) });
    const limits = rosterLimits(txnConfig);
    for (const group of ['pro', 'minors']) {
      if (counts[group] > limits[group]) add(team, `${group}_limit`, null,
        `${team.teamName} has ${counts[group]}/${limits[group]} ${group} players after pending drops.`,
        'File a drop or arrange a trade/callup to make room; commissioner processing time is allowed.', settings.rosterGraceHours);
    }
    if (team.cap.used > team.cap.cap + 0.01) add(team, 'cap_limit', null,
      `${team.teamName} uses $${team.cap.used.toLocaleString('en-US')} of its Fantrax-adjusted $${team.cap.cap.toLocaleString('en-US')} cap (including dead cap).`,
      'Contact the commish to bring the team under its adjusted cap. Dropping a guaranteed contract may not save cap.');
    next[team.teamId] = { items: tracked, at: now };
  }
  return { conditions, snapshot: next };
}

module.exports = { evaluate };
