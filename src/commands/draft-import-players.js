const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { isAdmin } = require('../config');
const { pool } = require('../draft/players');
const paths = require('../paths');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-import-players')
    .setDescription('Upload/replace the eligible players CSV (fantraxId,name,position,team,taken)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addAttachmentOption((o) =>
      o.setName('csv').setDescription('Players CSV').setRequired(true),
    ),

  async execute(interaction) {
    if (!isAdmin(interaction.user.id, interaction.member)) {
      await interaction.reply({ content: 'Admin only.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const att = interaction.options.getAttachment('csv');
    const res = await fetch(att.url);
    const text = await res.text();
    const count = pool.loadFromCsvText(text);
    pool.saveToFile(paths.PLAYERS_CSV);
    const available = pool.available().length;
    const taken = count - available;
    await interaction.editReply(
      `Loaded **${count}** players (${available} available, ${taken} already taken). Saved to \`data/players.csv\`.`,
    );
  },
};
