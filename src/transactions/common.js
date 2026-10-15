const { loadConfig } = require('../config');
const snapshot = require('./snapshot');

const KIND_CHANNEL = {
  nhl: 'nhlAddsChannelId',
  ahl: 'ahlAddsChannelId',
  drop: 'dropsChannelId',
};
const KIND_PREFIX = { nhl: '[NHL]', ahl: '[AHL]', drop: '[DROP]' };

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

/**
 * The caller's draft team. Owners of several teams pass `for_team`
 * (team name from autocomplete).
 */
function resolveTeam(interaction) {
  const owned = snapshot.teamsForUser(interaction.user.id);
  if (!owned.length) return { error: 'You are not an owner of any team in the draft order.' };
  const wanted = interaction.options.getString('for_team');
  if (wanted) {
    const team = owned.find((t) => t.teamName.toLowerCase() === wanted.trim().toLowerCase());
    return team ? { team } : { error: `You don't own **${wanted}**.` };
  }
  if (owned.length > 1) {
    return {
      error: `You own ${owned.length} teams (${owned.map((t) => t.teamName).join(', ')}). Pass \`for_team\`.`,
    };
  }
  return { team: owned[0] };
}

/** `for_team` autocomplete: teams the caller owns. */
function teamChoices(interaction, query) {
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
  targetChannelId,
  threadTitle,
  resolveTeam,
  teamChoices,
};
