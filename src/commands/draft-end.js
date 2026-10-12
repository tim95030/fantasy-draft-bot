const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { isAdmin } = require('../config');
const { engine } = require('../draft/engine');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-end')
    .setDescription('End the current draft (or close the make-up window)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    if (!isAdmin(interaction.user.id, interaction.member)) {
      await interaction.reply({ content: 'Admin only.', ephemeral: true });
      return;
    }
    if (engine.getState().status === 'makeup') {
      await interaction.reply({ content: 'Closing the make-up window.', ephemeral: true });
      await engine.finishMakeup('admin');
      return;
    }
    engine.end();
    await interaction.reply('Draft ended.');
  },
};
