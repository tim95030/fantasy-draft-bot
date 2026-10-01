const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const fs = require('fs');
const { isAdmin } = require('../config');
const { pool } = require('../draft/players');
const paths = require('../paths');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('draft-reset-players')
    .setDescription('Reload player pool from players.default.csv (discards live players.csv overrides)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    if (!isAdmin(interaction.user.id, interaction.member)) {
      await interaction.reply({ content: 'Admin only.', ephemeral: true });
      return;
    }
    if (!fs.existsSync(paths.PLAYERS_DEFAULT)) {
      await interaction.reply({
        content:
          'No `data/players.default.csv` found. Import with `/draft-import-players set_as_default:True` first.',
        ephemeral: true,
      });
      return;
    }
    fs.copyFileSync(paths.PLAYERS_DEFAULT, paths.PLAYERS_CSV);
    const count = pool.loadFromFile(paths.PLAYERS_CSV);
    await interaction.reply({
      content: `Reset player pool from default (**${count}** players, ${pool.available().length} available).`,
      ephemeral: true,
    });
  },
};
