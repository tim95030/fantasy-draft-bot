const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { isAdmin } = require('../config');
const { engine } = require('../draft/engine');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-resume')
    .setDescription('Resume a paused draft')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    if (!isAdmin(interaction.user.id, interaction.member)) {
      await interaction.reply({ content: 'Admin only.', ephemeral: true });
      return;
    }
    await interaction.deferReply();
    try {
      await engine.resume();
      await interaction.editReply('Draft resumed.');
    } catch (err) {
      await interaction.editReply(err.message);
    }
  },
};
