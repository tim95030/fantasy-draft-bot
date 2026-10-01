const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { isAdmin } = require('../config');
const { engine } = require('../draft/engine');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-start')
    .setDescription('Start (or restart) the draft from configured start round')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    if (!isAdmin(interaction.user.id, interaction.member)) {
      await interaction.reply({ content: 'Admin only.', ephemeral: true });
      return;
    }
    await interaction.deferReply();
    try {
      const state = await engine.startDraft({ announce: true });
      const slot = engine.currentSlot(state);
      await interaction.editReply(
        `Draft started. ${state.queue.length} slots queued. On the clock: **${slot.round}.${slot.pick}** <@${slot.discordUserId}>`,
      );
    } catch (err) {
      await interaction.editReply(`Could not start: ${err.message}`);
    }
  },
};
