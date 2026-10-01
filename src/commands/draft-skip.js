const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { isAdmin } = require('../config');
const { engine } = require('../draft/engine');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-skip')
    .setDescription('Force-skip the current pick')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    if (!isAdmin(interaction.user.id, interaction.member)) {
      await interaction.reply({ content: 'Admin only.', ephemeral: true });
      return;
    }
    await interaction.deferReply();
    try {
      const { slot, state } = engine.forceSkip();
      await interaction.editReply(
        `Skipped **${slot.round}.${slot.pick}** <@${slot.discordUserId}>.`,
      );
      if (state.status === 'running') {
        await engine.proceedToNextPick();
      }
    } catch (err) {
      await interaction.editReply(err.message);
    }
  },
};
