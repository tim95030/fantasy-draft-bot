const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const fs = require('fs');
const { isAdmin } = require('../config');
const paths = require('../paths');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-import-presets')
    .setDescription('Upload preset picks CSV (round,pick,fantraxId,drafterDiscordUserId)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addAttachmentOption((o) =>
      o.setName('csv').setDescription('Preset picks CSV').setRequired(true),
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
    fs.writeFileSync(paths.PRESET_CSV, text);
    const lines = text.trim().split(/\r?\n/).length - 1;
    await interaction.editReply(
      `Saved preset picks (${Math.max(0, lines)} rows). They apply on the next \`/draft-start\`.`,
    );
  },
};
