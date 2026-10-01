const { SlashCommandBuilder } = require('discord.js');
const { engine } = require('../draft/engine');

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
      picks = picks.filter((p) => String(p.discordUserId) === String(manager.id));
    }
    picks = picks.slice(-limit);

    if (!picks.length) {
      await interaction.reply({ content: 'No picks recorded yet.', ephemeral: true });
      return;
    }

    const lines = picks.map(
      (p) =>
        `**${p.round}.${p.pick}** ${p.playerName} ${p.position}, ${p.team} → <@${p.discordUserId}> (\`${p.fantraxId}\`)`,
    );

    let body = lines.join('\n');
    if (body.length > 1900) body = `${body.slice(0, 1900)}…`;
    await interaction.reply({ content: body });
  },
};
