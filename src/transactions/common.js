const { loadConfig, isAdmin } = require('../config');
const {
  loadOrder,
  normalizeTeam,
  ownerIds,
  teamOwnedBy,
} = require('../draft/order');
const snapshot = require('./snapshot');
const { faWindowError } = require('./faWindow');

const KIND_CHANNEL = {
  nhl: 'nhlAddsChannelId',
  ahl: 'ahlAddsChannelId',
  drop: 'dropsChannelId',
  callup: 'callupsChannelId',
};
const KIND_PREFIX = { nhl: '[NHL]', ahl: '[AHL]', drop: '[DROP]', callup: '[CALLUP]' };

function txnConfig() {
  return loadConfig().transactions;
}

/** Error text if the command can't run here, else null. */
function channelError(interaction, cfg = txnConfig()) {
  if (cfg.mode === 'live') return null;
  if (interaction.channelId === cfg.practiceChannelId) return null;
  return `While testing, this command only works in <#${cfg.practiceChannelId}>.`;
}

function targetChannelId(kind, cfg = txnConfig()) {
  return cfg.mode === 'live' ? cfg[KIND_CHANNEL[kind]] : cfg.practiceChannelId;
}

function threadTitle(kind, label, cfg = txnConfig()) {
  return cfg.mode === 'live' ? label : `${KIND_PREFIX[kind]} ${label}`;
}

function resolveTeamFromOption(value) {
  const order = loadOrder();
  const m = String(value || '').match(/^slot:(\d+)$/i);
  if (m) {
    const idx = Number(m[1]) - 1;
    if (idx < 0 || idx >= order.teams.length) return null;
    return normalizeTeam(order.teams[idx], idx);
  }
  const want = String(value || '')
    .trim()
    .toLowerCase();
  let idx = order.teams.findIndex(
    (t, i) => normalizeTeam(t, i).teamName.toLowerCase() === want,
  );
  if (idx < 0 && want) {
    const hits = order.teams
      .map((t, i) => ({ i, name: normalizeTeam(t, i).teamName.toLowerCase() }))
      .filter(({ name }) => name.includes(want) || want.includes(name));
    if (hits.length === 1) idx = hits[0].i;
  }
  if (idx < 0) return null;
  return normalizeTeam(order.teams[idx], idx);
}

function searchDraftTeams(query, limit = 25) {
  const order = loadOrder();
  const q = String(query || '')
    .trim()
    .toLowerCase();
  const scored = [];
  order.teams.forEach((raw, i) => {
    const team = normalizeTeam(raw, i);
    const name = team.teamName.toLowerCase();
    let score = 0;
    if (!q) score = 1;
    else if (name === q) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 50;
    else if (String(i + 1) === q || `slot ${i + 1}`.includes(q)) score = 40;
    else return;
    scored.push({ score, i, team });
  });
  scored.sort(
    (a, b) => b.score - a.score || a.team.teamName.localeCompare(b.team.teamName),
  );
  return scored.slice(0, limit);
}

function actingOwnerId(team) {
  const ids = ownerIds(team);
  return ids[0] || null;
}

/**
 * Draft team for this transaction. Multi-team owners pass `for_team`.
 * Draft admins may pass `for_team` for any slot (bid/add is credited to that team's owner).
 */
function resolveTeam(interaction) {
  const wanted = interaction.options.getString('for_team');
  const admin = isAdmin(interaction.user.id, interaction.member);
  const owned = snapshot.teamsForUser(interaction.user.id);

  if (wanted) {
    const fromOption = resolveTeamFromOption(wanted);
    const ownedMatch = owned.find(
      (t) => t.teamName.toLowerCase() === String(wanted).trim().toLowerCase(),
    );
    const team = admin ? fromOption || ownedMatch : ownedMatch;
    if (!team) {
      if (admin) return { error: 'Team not found. Pick one from `for_team` autocomplete.' };
      return { error: `You don't own **${wanted}**.` };
    }
    if (!admin && !teamOwnedBy(team, interaction.user.id)) {
      return { error: `You don't own **${team.teamName}**.` };
    }
    const actingUserId = actingOwnerId(team);
    if (!actingUserId) {
      return { error: `**${team.teamName}** has no owners in the draft order.` };
    }
    return { team, actingUserId };
  }

  if (!owned.length) {
    if (admin) {
      return { error: 'Pass `for_team` to choose which fantasy team this is for.' };
    }
    return { error: 'You are not an owner of any team in the draft order.' };
  }
  if (owned.length > 1) {
    return {
      error: `You own ${owned.length} teams (${owned.map((t) => t.teamName).join(', ')}). Pass \`for_team\`.`,
    };
  }
  return { team: owned[0], actingUserId: String(interaction.user.id) };
}

/** `for_team` autocomplete: all teams for admins, else teams the caller owns. */
function teamChoices(interaction, query) {
  const admin = isAdmin(interaction.user.id, interaction.member);
  if (admin) {
    return searchDraftTeams(query, 25).map(({ i, team }) => ({
      name: `${team.teamName} (#${i + 1})`.slice(0, 100),
      value: `slot:${i + 1}`,
    }));
  }
  const q = String(query || '').toLowerCase();
  return snapshot
    .teamsForUser(interaction.user.id)
    .filter((t) => t.teamName.toLowerCase().includes(q))
    .slice(0, 25)
    .map((t) => ({ name: t.teamName.slice(0, 100), value: t.teamName.slice(0, 100) }));
}

module.exports = {
  txnConfig,
  channelError,
  faWindowError,
  targetChannelId,
  threadTitle,
  resolveTeam,
  teamChoices,
};
