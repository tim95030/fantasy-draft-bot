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
    )
    .addBooleanOption((o) =>
      o
        .setName('set_as_default')
        .setDescription(
          'Also save as players.default.csv (baseline used on fresh installs / when players.csv is missing)',
        ),
    ),

  async execute(interaction) {
    if (!isAdmin(interaction.user.id, interaction.member)) {
      await interaction.reply({ content: 'Admin only.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const att = interaction.options.getAttachment('csv');
    const setAsDefault = interaction.options.getBoolean('set_as_default') || false;
    const res = await fetch(att.url);
    const text = await res.text();
    const count = pool.loadFromCsvText(text);
    pool.saveToFile(paths.PLAYERS_CSV);
    let defaultNote = '';
    if (setAsDefault) {
      pool.saveAsDefault();
      defaultNote =
        ' Also saved as `data/players.default.csv` (commit this file to the repo if you want it in git).';
    }
    const available = pool.available().length;
    const taken = count - available;
    await interaction.editReply(
      `Loaded **${count}** players (${available} available, ${taken} already taken). Saved to \`data/players.csv\`.${defaultNote}`,
    );
  },
};
