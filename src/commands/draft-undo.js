const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { isAdmin } = require('../config');
const { engine } = require('../draft/engine');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-undo')
    .setDescription('Undo the last recorded pick')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    if (!isAdmin(interaction.user.id, interaction.member)) {
      await interaction.reply({ content: 'Admin only.', ephemeral: true });
      return;
    }
    try {
      const last = engine.undoLast();
      await interaction.reply(
        `Undid **${last.round}.${last.pick}** ${last.playerName} (${last.fantraxId}) from <@${last.discordUserId}>.`,
      );
      const state = engine.getState();
      if (state.status === 'running') await engine.announceOnClock(state);
    } catch (err) {
      await interaction.reply({ content: err.message, ephemeral: true });
    }
  },
};
