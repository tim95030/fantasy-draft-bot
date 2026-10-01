const { AttachmentBuilder, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { isAdmin } = require('../config');
const { engine } = require('../draft/engine');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-export')
    .setDescription('Export recorded picks as CSV')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    if (!isAdmin(interaction.user.id, interaction.member)) {
      await interaction.reply({ content: 'Admin only.', ephemeral: true });
      return;
    }
    const csv = engine.exportPicksCsv();
    const file = new AttachmentBuilder(Buffer.from(csv, 'utf8'), {
      name: 'draft-picks.csv',
    });
    await interaction.reply({
      content: `Exported **${engine.getState().picks.length}** picks.`,
      files: [file],
      ephemeral: true,
    });
  },
};
