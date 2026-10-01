const { SlashCommandBuilder } = require('discord.js');
const { engine } = require('../draft/engine');
const { loadOrder, findTeamsForUser, normalizeTeam } = require('../draft/order');

function fantasyTeamLabel(pick) {
  if (pick.teamName) return pick.teamName;
  if (pick.displayName && pick.displayName !== pick.discordUserId) return pick.displayName;
  // Older picks: resolve from current draft order by owner
  const teams = findTeamsForUser(loadOrder(), pick.discordUserId);
  if (teams.length === 1) return teams[0].teamName;
  if (Array.isArray(pick.ownerIds) && pick.ownerIds.length) {
    const order = loadOrder();
    const match = order.teams
      .map((t, i) => normalizeTeam(t, i))
      .find((t) =>
        t.owners.some((o) => pick.ownerIds.map(String).includes(String(o.discordUserId))),
      );
    if (match) return match.teamName;
  }
  return null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-board')
    .setDescription('Show recent picks')
    .addUserOption((o) =>
      o.setName('manager').setDescription('Filter picks to one manager'),
    )
    .addIntegerOption((o) =>
      o
        .setName('limit')
        .setDescription('How many recent picks to show (default 20)')
        .setMinValue(1)
        .setMaxValue(50),
    ),

  async execute(interaction) {
    const manager = interaction.options.getUser('manager');
    const limit = interaction.options.getInteger('limit') || 20;
    const state = engine.getState();
    let picks = [...state.picks];
    if (manager) {
      const id = String(manager.id);
      picks = picks.filter(
        (p) =>
          String(p.discordUserId) === id ||
          (Array.isArray(p.ownerIds) && p.ownerIds.map(String).includes(id)),
      );
    }
    picks = picks.slice(-limit);

    if (!picks.length) {
      await interaction.reply({ content: 'No picks recorded yet.', ephemeral: true });
      return;
    }

    const lines = picks.map((p) => {
      const fantasyTeam = fantasyTeamLabel(p);
      const teamPart = fantasyTeam ? `**${fantasyTeam}**` : `<@${p.discordUserId}>`;
      return (
        `**${p.round}.${p.pick}** ${teamPart} — ${p.playerName} ${p.position}, ${p.team}` +
        ` (\`${p.fantraxId}\`)`
      );
    });

    let body = lines.join('\n');
    if (body.length > 1900) body = `${body.slice(0, 1900)}…`;
    await interaction.reply({ content: body, ephemeral: true });
  },
};
