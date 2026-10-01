const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { isAdmin } = require('../config');
const { engine } = require('../draft/engine');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-pause')
    .setDescription('Pause the pick clock')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    if (!isAdmin(interaction.user.id, interaction.member)) {
      await interaction.reply({ content: 'Admin only.', ephemeral: true });
      return;
    }
    try {
      engine.pause();
      await interaction.reply('Draft paused.');
    } catch (err) {
      await interaction.reply({ content: err.message, ephemeral: true });
    }
  },
};
